import { useEffect, useState, useRef } from 'react';
import { useParams }   from 'react-router-dom';
import io              from 'socket.io-client';
import * as mediasoup  from 'mediasoup-client';

const socket = io('https://webrtcserver.mmup.org', { transports:['websocket'] });

const TILE_W = 320;              // base tile width (the grid will auto-wrap)

export default function Room() {
  const { roomId } = useParams();

  /* ---------- refs & state ---------------------------------------- */
  const localRef  = useRef(null);
  const device    = useRef(null);
  const sendT     = useRef(null);
  const recvT     = useRef(null);
  const consumers = useRef(new Set());
  const pending   = useRef([]);
  const audioProd = useRef(null);

  const [isOwner,      setIsOwner]      = useState(false);
  const [approved,     setApproved]     = useState(false);
  const [people,       setPeople]       = useState({});  // socketId → { stream }
  const [micEnabled,   setMicEnabled]   = useState(true);
  const [stagePeerId,  setStagePeerId]  = useState(null); // null = grid view

  /* ---------- join ------------------------------------------------- */
  useEffect(() => {
    socket.emit('join-room', { roomId }, (r = {}) => {
      setIsOwner(r.isOwner);
      if (r.isOwner || r.waitForApproval === false) {
        setApproved(true);
        initMedia();
      }
    });
  }, [roomId]);

  /* ---------- listeners ------------------------------------------- */
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

    socket.on('participant-left', ({ socketId }) =>
      setPeople(p => { const cp = { ...p }; delete cp[socketId]; return cp; }));

    socket.on('join-denied', () => { alert('Join denied');  location.replace('/'); });
    socket.on('room-closed', () => { alert('Room closed');  location.replace('/'); });

    return () => socket.off('join-request')
                       .off('join-approved')
                       .off('newProducer')
                       .off('participant-left');
  }, [isOwner]);

  /* ---------- mediasoup bootstrap --------------------------------- */
  async function initMedia() {
    if (sendT.current) return;

    const cam = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    localRef.current.srcObject = cam;

    /* — device — */
    const caps = await new Promise(res => socket.emit('getRouterRtpCapabilities', res));
    device.current = new mediasoup.Device();
    await device.current.load({ routerRtpCapabilities:caps });

    /* — send transport — */
    const pSend = await new Promise(res => socket.emit('createTransport', { consuming:false }, res));
    sendT.current = device.current.createSendTransport({
      ...pSend, iceServers:pSend.iceServers, iceTransportPolicy:'relay'
    });

    sendT.current.on('connect', ({ dtlsParameters }, ok, bad) =>
      socket.emit('connectTransport',
        { transportId:sendT.current.id, dtlsParameters },
        ack => ack?.error ? bad(ack.error) : ok()));

    sendT.current.on('produce', ({ kind, rtpParameters }, ok, bad) =>
      socket.emit('produce',
        { transportId:sendT.current.id, kind, rtpParameters },
        ({ id, error }) => error ? bad(error) : ok({ id })));

    /* publish tracks & keep audio producer */
    await Promise.all(
      cam.getTracks().map(async track => {
        const prod = await sendT.current.produce({ track });
        if (track.kind === 'audio') audioProd.current = prod;
      })
    );

    /* — recv transport — */
    const pRecv = await new Promise(res => socket.emit('createTransport', { consuming:true }, res));
    recvT.current = device.current.createRecvTransport({
      ...pRecv, iceServers:pRecv.iceServers, iceTransportPolicy:'relay'
    });

    recvT.current.on('connect', ({ dtlsParameters }, ok, bad) =>
      socket.emit('connectTransport',
        { transportId:recvT.current.id, dtlsParameters },
        ack => ack?.error ? bad(ack.error) : ok()));

    while (pending.current.length) consumeProducer(pending.current.shift());
  }

  /* ---------- producer helpers ------------------------------------ */
  function handleProducer(info){
    if (!recvT.current){ pending.current.push(info); return; }
    consumeProducer(info);
  }

  function consumeProducer({ producerId, socketId }){
    if (consumers.current.has(producerId)) return;
    consumers.current.add(producerId);

    socket.emit('consume',
      { producerId, rtpCapabilities:device.current.rtpCapabilities },
      async ({ id, kind, rtpParameters, error }) => {
        if (error) return console.error(error);
        const cons = await recvT.current.consume({ id, producerId, kind, rtpParameters });
        await cons.resume();

        setPeople(p => {
          const stream = p[socketId]?.stream ?? new MediaStream();
          stream.addTrack(cons.track);
          return { ...p, [socketId]:{ stream } };
        });
      });
  }

  /* ---------- UI helpers ------------------------------------------ */
  const toggleMic = () => {
    const p = audioProd.current; if (!p) return;
    p.paused ? p.resume() : p.pause();
    setMicEnabled(!p.paused);
  };

  const allTiles = Object.entries({ you:'local', ...people });

  /* ---------- render ---------------------------------------------- */
  return (
    <div style={styles.wrapper}>
      <header style={styles.header}>
        <h3>Room {roomId}</h3>
        <button onClick={toggleMic}>
          {micEnabled ? 'Mute mic ⏸' : 'Un-mute mic 🔊'}
        </button>
      </header>

      {stagePeerId ? (
        <Stage
          peerId={stagePeerId === 'you' ? 'you' : stagePeerId}
          stream={stagePeerId === 'you'
                    ? localRef.current?.srcObject
                    : people[stagePeerId]?.stream}
          onExit={()=>setStagePeerId(null)}
        />
      ) : (
        <div style={styles.grid}>
          {/* local first */}
          <Tile
            key="you" peerId="you" refEl={localRef}
            onClick={()=>setStagePeerId('you')}
          />

          {Object.entries(people).map(([id, { stream }]) => (
            <Tile key={id} peerId={id} stream={stream}
                  onClick={()=>setStagePeerId(id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Tile --------------------------------------------------- */
function Tile({ peerId, stream, refEl, onClick }){
  return (
    <div style={{ ...styles.tile, cursor:'pointer' }} onClick={onClick}>
      <video
        ref={el => { if (refEl) refEl.current = el; if (el && stream) el.srcObject = stream; }}
        autoPlay playsInline muted={peerId==='you'}
        style={styles.vid}
      />
      <span style={styles.label}>{peerId==='you' ? 'You' : peerId}</span>
    </div>
  );
}

/* ---------- Stage (full-width) ------------------------------------ */
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

/* ---------- quick inline styles ----------------------------------- */
const styles = {
  wrapper:{ padding:16,fontFamily:'sans-serif',height:'100vh',boxSizing:'border-box' },
  header :{ display:'flex',gap:12,alignItems:'center',marginBottom:8 },
  grid   :{ display:'grid', gap:8,
            gridTemplateColumns:`repeat(auto-fill,minmax(${TILE_W}px,1fr))` },
  tile   :{ position:'relative', width:'100%', paddingTop:'56.25%',  /* 16:9 */
            background:'#000', overflow:'hidden', borderRadius:8 },
  vid    :{ position:'absolute', top:0,left:0,width:'100%',height:'100%',
            objectFit:'cover' },
  label  :{ position:'absolute', bottom:4,left:6,
            color:'#fff',background:'#0008',padding:'2px 6px',fontSize:12,
            borderRadius:4 },
  stage  :{ position:'relative', width:'100%', height:'calc(100vh - 70px)',
            background:'#000', borderRadius:8, overflow:'hidden' },
  stageVideo:{ width:'100%', height:'100%', objectFit:'contain' },
  closeBtn:{ position:'absolute', top:10,right:10,fontSize:24,
             background:'none', border:'none', color:'#fff', cursor:'pointer' }
};
