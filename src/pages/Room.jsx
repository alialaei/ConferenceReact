import { useEffect, useState, useRef } from 'react';
import { useParams }   from 'react-router-dom';
import io              from 'socket.io-client';
import * as mediasoup  from 'mediasoup-client';

const socket = io('https://webrtcserver.mmup.org', { transports:['websocket'] });
const TILE_W = 320;               // base tile width for the grid

export default function Room() {
  const { roomId } = useParams();

  /* ------------- refs & state ------------------------------------- */
  const localVideoRef   = useRef(null);
  const device          = useRef(null);
  const sendT           = useRef(null);
  const recvT           = useRef(null);
  const consumers       = useRef(new Set());
  const pending         = useRef([]);

  const audioProducer   = useRef(null);     // for mute/un-mute
  const shareProducer   = useRef(null);     // our own screen share

  const [localStream, setLocalStream]   = useState(null);
  const [isOwner,     setIsOwner]       = useState(false);
  const [approved,    setApproved]      = useState(false);
  const [people,      setPeople]        = useState({});   // socketId → { stream }
  const [micOn,       setMicOn]         = useState(true);
  const [stageId,     setStageId]       = useState(null); // null => grid
  const [share,       setShare]         = useState(null); // { socketId, stream }

  /* ------------- join --------------------------------------------- */
  useEffect(() => {
    socket.emit('join-room', { roomId }, (r = {}) => {
      setIsOwner(r.isOwner);
      if (r.isOwner || r.waitForApproval === false) {
        setApproved(true);
        initMedia();
      }
    });
  }, [roomId]);

  /* ------------- listeners ---------------------------------------- */
  useEffect(() => {
    const approve = ({ socketId }) =>
      window.confirm(`Accept ${socketId}?`)
        ? socket.emit('approve-join', { targetSocketId: socketId })
        : socket.emit('deny-join',    { targetSocketId: socketId });

    const joined = ({ existingProducers }) => {
      setApproved(true);
      initMedia().then(() => existingProducers.forEach(handleProducer));
    };

    socket.on('join-request',  ({ socketId }) => isOwner && approve({ socketId }));
    socket.on('join-approved', joined);
    socket.on('newProducer',   handleProducer);

    socket.on('participant-left', ({ socketId }) => {
      setPeople(p => { const cp = { ...p }; delete cp[socketId]; return cp; });
      if (share?.socketId === socketId) setShare(null);
    });

    socket.on('join-denied', () => { alert('Join denied');  location.replace('/'); });
    socket.on('room-closed', () => { alert('Room closed');  location.replace('/'); });

    return () => socket.off('join-request')
                       .off('join-approved')
                       .off('newProducer')
                       .off('participant-left');
  }, [isOwner, share]);

  /* ------------- mediasoup bootstrap ------------------------------ */
  async function initMedia() {
    if (sendT.current) return;

    /* local cam & mic */
    const cam = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    setLocalStream(cam);

    /* attach immediately */
    if (localVideoRef.current) localVideoRef.current.srcObject = cam;

    /* device */
    const caps = await new Promise(res => socket.emit('getRouterRtpCapabilities', res));
    device.current = new mediasoup.Device();
    await device.current.load({ routerRtpCapabilities:caps });

    /* SEND transport */
    const pSend = await new Promise(res => socket.emit('createTransport', { consuming:false }, res));
    sendT.current = device.current.createSendTransport({
      ...pSend, iceServers:pSend.iceServers, iceTransportPolicy:'relay'
    });

    sendT.current.on('connect', ({ dtlsParameters }, ok, bad) =>
      socket.emit('connectTransport',
        { transportId:sendT.current.id, dtlsParameters },
        ack => ack?.error ? bad(ack.error) : ok()));

    sendT.current.on('produce', ({ kind, rtpParameters, appData }, ok, bad) =>
      socket.emit('produce',
        { transportId:sendT.current.id, kind, rtpParameters, appData },
        ({ id, error }) => error ? bad(error) : ok({ id })));

    /* publish cam+mic */
    await Promise.all(
      cam.getTracks().map(async tr => {
        const prod = await sendT.current.produce({ track:tr });
        if (tr.kind === 'audio') audioProducer.current = prod;
      })
    );

    /* RECV transport */
    const pRecv = await new Promise(res => socket.emit('createTransport', { consuming:true }, res));
    recvT.current = device.current.createRecvTransport({
      ...pRecv, iceServers:pRecv.iceServers, iceTransportPolicy:'relay'
    });

    recvT.current.on('connect', ({ dtlsParameters }, ok, bad) =>
      socket.emit('connectTransport',
        { transportId:recvT.current.id, dtlsParameters },
        ack => ack?.error ? bad(ack.error) : ok()));

    /* flush queued producers */
    while (pending.current.length) consumeProducer(pending.current.shift());
  }

  /* ------------- producer helpers --------------------------------- */
  function handleProducer(info){
    if (!recvT.current){ pending.current.push(info); return; }
    consumeProducer(info);
  }

  function consumeProducer({ producerId, socketId }){
    if (consumers.current.has(producerId)) return;
    consumers.current.add(producerId);

    socket.emit(
      'consume',
      { producerId, rtpCapabilities:device.current.rtpCapabilities },
      async ({ id, kind, rtpParameters, error }) => {
        if (error) return console.error(error);
        const cons = await recvT.current.consume({ id, producerId, kind, rtpParameters });
        await cons.resume();

        // detect screen share by label (Chrome/Firefox) or by contentHint
        const isScreen =
          kind === 'video' &&
          (cons.track.label.toLowerCase().includes('screen') ||
           cons.track.label.toLowerCase().includes('share'));

        setPeople(p => {
          const stream = p[socketId]?.stream ?? new MediaStream();
          stream.addTrack(cons.track);
          return { ...p, [socketId]:{ stream } };
        });

        if (isScreen) setShare({ socketId, stream:new MediaStream([cons.track]) });
      });
  }

  /* ------------- controls ----------------------------------------- */
  const toggleMic = () => {
    const p = audioProducer.current; if (!p) return;
    p.paused ? p.resume() : p.pause();
    setMicOn(!p.paused);
  };

  const startShare = async () => {
    if (share) return;                               // someone already sharing
    try{
      const disp = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
      const track = disp.getVideoTracks()[0];

      /* close when the user stops from browser UI */
      track.onended = stopShare;

      shareProducer.current = await sendT.current.produce({
        track, appData:{ screen:true }
      });

      setShare({ socketId:'you', stream:new MediaStream([track]) });
    }catch(e){ console.warn(e); }
  };

  const stopShare = async () => {
    if (!shareProducer.current) return;
    shareProducer.current.close();                   // informs the SFU
    shareProducer.current = null;
    setShare(null);
  };

  /* ------------- rendering helpers -------------------------------- */
  const fullButton = (onClick) => (
    <button onClick={onClick} style={styles.fullBtn}>⤢</button>
  );

  /* ------------- JSX ---------------------------------------------- */
  return (
    <div style={styles.wrapper}>
      {/* top bar --------------------------------------------------- */}
      <header style={styles.header}>
        <h3>Room {roomId}</h3>

        <button onClick={toggleMic}>
          {micOn ? 'Mute mic ⏸' : 'Un-mute 🔊'}
        </button>

        {share
          ? (share.socketId === 'you'
               ? <button onClick={stopShare}>Stop share 🛑</button>
               : <button disabled>Screen in progress…</button>)
          : <button onClick={startShare}>Share screen 🖥️</button>}
      </header>

      {/* stage OR grid ------------------------------------------- */}
      {stageId ? (
        <Stage
          peerId={stageId}
          stream={stageId==='you' ? localStream : people[stageId]?.stream}
          onExit={()=>setStageId(null)}
        />
      ) : (
        <>
          {/* screen share (if any) */}
          {share && (
            <div style={styles.shareBox}>
              <video autoPlay playsInline
                     muted={share.socketId==='you'}
                     ref={el => el && (el.srcObject = share.stream)}
                     style={styles.shareVideo}/>
              <span style={styles.shareLabel}>
                {share.socketId==='you' ? 'Your screen' : `${share.socketId}'s screen`}
              </span>
            </div>
          )}

          {/* grid of cameras */}
          <div style={styles.grid}>
            {/* local (you) */}
            <Tile
              peerId="you"
              stream={localStream}
              refEl={localVideoRef}
              onStage={()=>setStageId('you')}
              fullBtn={fullButton(()=>setStageId('you'))}
            />

            {Object.entries(people).map(([id, { stream }]) => (
              <Tile key={id}
                    peerId={id}
                    stream={stream}
                    onStage={()=>setStageId(id)}
                    fullBtn={fullButton(()=>setStageId(id))}/>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------ Tile component -------------------------------------- */
function Tile({ peerId, stream, refEl, onStage, fullBtn }){
  return (
    <div style={styles.tile}>
      <video
        ref={el => {
          if (refEl) refEl.current = el;
          if (el && stream) el.srcObject = stream;
        }}
        autoPlay playsInline muted={peerId==='you'}
        style={styles.vid}
      />
      <span style={styles.label}>{peerId==='you' ? 'You' : peerId}</span>
      {fullBtn /* top-right expand button */}
      {/* click anywhere also toggles stage */}
      <div style={styles.clickCatcher} onClick={onStage}/>
    </div>
  );
}

/* ------------ Stage (full-width) ---------------------------------- */
function Stage({ peerId, stream, onExit }){
  return (
    <div style={styles.stage}>
      <video autoPlay playsInline muted={peerId==='you'}
             ref={el => el && (el.srcObject = stream)}
             style={styles.stageVideo}/>
      <button style={styles.closeBtn} onClick={onExit}>✕</button>
    </div>
  );
}

/* ------------ quick inline styles --------------------------------- */
const styles = {
  wrapper :{ padding:16,fontFamily:'sans-serif',height:'100vh',
             boxSizing:'border-box',display:'flex',flexDirection:'column' },
  header  :{ display:'flex',gap:12,alignItems:'center',marginBottom:8 },
  grid    :{ display:'grid', gap:8,
             gridTemplateColumns:`repeat(auto-fill,minmax(${TILE_W}px,1fr))`,
             flex:1, overflow:'auto' },

  tile    :{ position:'relative', width:'100%', paddingTop:'56.25%',
             background:'#000', borderRadius:8, overflow:'hidden' },
  vid     :{ position:'absolute', top:0,left:0,width:'100%',height:'100%',
             objectFit:'cover' },
  label   :{ position:'absolute', bottom:4,left:6,fontSize:12,
             color:'#fff',background:'#0008',padding:'2px 6px',borderRadius:4 },
  fullBtn :{ position:'absolute', top:4,right:4,zIndex:2,
             background:'#0006',color:'#fff',border:'none',borderRadius:4,
             cursor:'pointer',padding:'0 6px' },
  clickCatcher:{ position:'absolute', inset:0, cursor:'pointer' },

  stage   :{ position:'relative', flex:1, background:'#000',
             borderRadius:8, overflow:'hidden' },
  stageVideo:{ width:'100%', height:'100%', objectFit:'contain' },
  closeBtn:{ position:'absolute', top:10,right:10,fontSize:24,
             background:'none', border:'none', color:'#fff', cursor:'pointer' },

  /* screen share tile */
  shareBox :{ position:'relative', width:'100%', paddingTop:'38%', marginBottom:8,
              background:'#000', borderRadius:8, overflow:'hidden' },
  shareVideo:{ position:'absolute', top:0,left:0,width:'100%',height:'100%',
               objectFit:'contain' },
  shareLabel:{ position:'absolute', bottom:4,left:6,fontSize:12,
               color:'#fff',background:'#0008',padding:'2px 6px',borderRadius:4 }
};
