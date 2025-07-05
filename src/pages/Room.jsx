import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import * as mediasoup from 'mediasoup-client';
import CodeMirror from '@uiw/react-codemirror';
import '@uiw/react-codemirror/dist/codemirror.css';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';

const socket  = io('https://webrtcserver.mmup.org', { transports:['websocket'] });
const TILE_W  = 320;

function CodePad({ roomId, editable }) {
  const [code, setCode] = useState('');

  /* ① ask the server for the latest text once */
  useEffect(() => {
    socket.emit('code-get', { roomId }, (text) => setCode(text));
  }, [roomId]);

  /* ② live updates from *other* peers */
  useEffect(() => {
    const h = ({ text }) => setCode(text);
    socket.on('code-update', h);
    return () => socket.off('code-update', h);
  }, []);

  /* ③ local edits → broadcast */
  const onChange = useCallback(
    (val) => {
      setCode(val);
      socket.emit('code-set', { roomId, text: val });
    },
    [roomId]
  );

  return (
    <div style={styles.codeBox}>
      <CodeMirror
        value={code}
        height="100%"
        theme="dark"
        extensions={[javascript()]}
        readOnly={!editable}
        onChange={editable ? onChange : undefined}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Room                                                               */
/* ──────────────────────────────────────────────────────────────────── */
export default function Room() {
  const { roomId } = useParams();

  /* ----- refs + state -------------------------------------------- */
  const localVideoRef = useRef(null);
  const device        = useRef(null);
  const sendT         = useRef(null);
  const recvT         = useRef(null);
  const pending       = useRef([]);
  const consumers     = useRef(new Set());

  const audioProducer = useRef(null);
  const shareProducer = useRef(null);

  const [localStream, setLocalStream] = useState(null);
  const [people,      setPeople]      = useState({});      // socketId → { stream }
  const [share,       setShare]       = useState(null);    // null | "pending" | { socketId, stream }

  const [isOwner,  setIsOwner]  = useState(false);
  const [approved, setApproved] = useState(false);
  const [micOn,    setMicOn]    = useState(true);
  const [stageId,  setStageId]  = useState(null);

  /* ----- join ----------------------------------------------------- */
  useEffect(() => {
    socket.emit('join-room', { roomId }, (r = {}) => {
      setIsOwner(r.isOwner);
      if (r.isOwner || r.waitForApproval === false) {
        setApproved(true);
        initMedia();
      }
    });
  }, [roomId]);

  /* ----- socket listeners ---------------------------------------- */
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
    socket.on('screen-stopped',() => setShare(null));

    socket.on('participant-left', ({ socketId }) => {
      setPeople(p => { const c = { ...p }; delete c[socketId]; return c; });
      if (share && share.socketId === socketId) setShare(null);
    });

    socket.on('join-denied', () => { alert('Join denied');  location.replace('/'); });
    socket.on('room-closed', () => { alert('Room closed');  location.replace('/'); });

    return () => socket.off('join-request')
                       .off('join-approved')
                       .off('newProducer')
                       .off('participant-left')
                       .off('screen-stopped');
  }, [isOwner, share]);

  /* ----- mediasoup bootstrap ------------------------------------- */
  async function initMedia() {
    if (sendT.current) return;                       // already up

    const cam = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    setLocalStream(cam);
    localVideoRef.current && (localVideoRef.current.srcObject = cam);

    const caps = await new Promise(r => socket.emit('getRouterRtpCapabilities', r));
    device.current = new mediasoup.Device();
    await device.current.load({ routerRtpCapabilities:caps });

    /* SEND */
    const ps = await new Promise(r => socket.emit('createTransport', { consuming:false }, r));
    sendT.current = device.current.createSendTransport({
      ...ps, iceServers:ps.iceServers, iceTransportPolicy:'relay'
    });

    sendT.current.on('connect', ({ dtlsParameters }, ok, bad) =>
      socket.emit('connectTransport',
        { transportId:sendT.current.id, dtlsParameters },
        a => a?.error ? bad(a.error) : ok()));

    sendT.current.on('produce', ({ kind, rtpParameters, appData }, ok, bad) =>
      socket.emit('produce',
        { transportId:sendT.current.id, kind, rtpParameters, appData },
        ({ id, error }) => error ? bad(error) : ok({ id })));

    await Promise.all(
      cam.getTracks().map(async t => {
        const tag = t.kind === 'video' ? 'cam' : 'mic';
        const p   = await sendT.current.produce({ track:t, appData:{ mediaTag:tag } });
        if (tag === 'mic') audioProducer.current = p;
      })
    );

    /* RECV */
    const pr = await new Promise(r => socket.emit('createTransport', { consuming:true }, r));
    recvT.current = device.current.createRecvTransport({
      ...pr, iceServers:pr.iceServers, iceTransportPolicy:'relay'
    });

    recvT.current.on('connect', ({ dtlsParameters }, ok, bad) =>
      socket.emit('connectTransport',
        { transportId:recvT.current.id, dtlsParameters },
        a => a?.error ? bad(a.error) : ok()));

    while (pending.current.length) consumeProducer(pending.current.shift());
  }

  /* ----- consume helpers ----------------------------------------- */
  function handleProducer(info){
    if (!recvT.current){ pending.current.push(info); return; }
    consumeProducer(info);
  }

  function consumeProducer(info){
    const { producerId, socketId, mediaTag } = info;
    if (consumers.current.has(producerId)) return;
    consumers.current.add(producerId);

    socket.emit('consume',
      { producerId, rtpCapabilities:device.current.rtpCapabilities },
      async ({ id, kind, rtpParameters, error }) => {
        if (error) return console.error(error);
        const cons = await recvT.current.consume({ id, producerId, kind, rtpParameters });
        await cons.resume();

        const isScreen = mediaTag === 'screen';

        const clearShare = () =>
          setShare(s => (s && s.socketId === socketId ? null : s));
        cons.on('producerclose', clearShare);
        cons.track.onended = clearShare;

        if (isScreen){
          setShare({ socketId, stream:new MediaStream([cons.track]) });
        }else{
          setPeople(p => {
            const stream = p[socketId]?.stream ?? new MediaStream();
            stream.addTrack(cons.track);
            return { ...p, [socketId]:{ stream } };
          });
        }
      });
  }

  /* ----- controls ------------------------------------------------- */
  const toggleMic = () => {
    const p = audioProducer.current;
    if (!p) return;
    p.paused ? p.resume() : p.pause();
    setMicOn(!p.paused);
  };

  const startShare = async () => {
    if (share && share !== 'pending') return;   // only one at a time
    try {
      setShare('pending');                      // UI hint – waiting for OS dialog
      const disp  = await navigator.mediaDevices.getDisplayMedia({ video:true });
      const track = disp.getVideoTracks()[0];
      track.onended = stopShare;

      shareProducer.current = await sendT.current.produce({
        track, appData:{ mediaTag:'screen' }
      });
      setShare({ socketId:'you', stream:new MediaStream([track]) });
    } catch (e){
      // User ignored or denied → reset & guide
      setShare(null);
      if (e.name === 'NotAllowedError'){
        alert(
          "iOS needs two taps to start screen sharing:\n\n" +
          "1) Tap 'Allow' on the tiny permission banner at the very top.\n" +
          "2) Tap 'Share screen' again and pick Safari."
        );
      } else {
        console.error(e);
      }
    }
  };

  const stopShare = () => {
    if (!shareProducer.current) return;
    shareProducer.current.close();
    shareProducer.current = null;
    setShare(null);
    socket.emit('stop-screen');
  };

  /* ----- UI ------------------------------------------------------- */
  return (
    <div style={styles.wrapper}>
      <header style={styles.header}>
        <h3>Room {roomId}</h3>
        <button onClick={toggleMic}>{micOn ? 'Mute ⏸' : 'Un-mute 🔊'}</button>

        {share === 'pending' && (
          <button disabled>Waiting for permission…</button>
        )}

        {share && share !== 'pending' ? (
          share.socketId === 'you'
            ? <button onClick={stopShare}>Stop share 🛑</button>
            : <button disabled>Screen in progress…</button>
        ) : null}

        {!share && share !== 'pending' && (
          <button onClick={startShare}>Share screen 🖥️</button>
        )}
      </header>

      {stageId ? (
        <Stage
          peerId={stageId}
          stream={stageId === 'you' ? localStream : people[stageId]?.stream}
          onExit={() => setStageId(null)}
        />
      ) : (
        <>
          {share && share !== 'pending' && (
            <div style={styles.shareBox}>
              <video
                autoPlay playsInline
                muted={share.socketId === 'you'}
                ref={el => el && (el.srcObject = share.stream)}
                style={styles.shareVideo}
              />
              <span style={styles.shareLabel}>
                {share.socketId === 'you' ? 'Your screen'
                                           : `${share.socketId}'s screen`}
              </span>
            </div>
          )}

          <div style={styles.grid}>
            <Tile
              peerId="you"
              stream={localStream}
              refEl={localVideoRef}
              onStage={() => setStageId('you')}
            />
            {Object.entries(people).map(([id, { stream }]) => (
              <Tile key={id}
                    peerId={id}
                    stream={stream}
                    onStage={() => setStageId(id)} />
            ))}
          </div>
          <CodePad roomId={roomId} editable={isOwner /* change as you like */} />
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Presentational helpers                                             */
/* ──────────────────────────────────────────────────────────────────── */
function Tile({ peerId, stream, refEl, onStage }){
  return (
    <div style={styles.tile} onClick={onStage}>
      <video
        ref={el => {
          if (refEl) refEl.current = el;
          el && stream && (el.srcObject = stream);
        }}
        autoPlay playsInline muted={peerId === 'you'}
        style={styles.vid}
      />
      <span style={styles.label}>{peerId === 'you' ? 'You' : peerId}</span>
      <button style={styles.fullBtn}>⤢</button>
    </div>
  );
}

function Stage({ peerId, stream, onExit }){
  return (
    <div style={styles.stage}>
      <video
        autoPlay playsInline muted={peerId === 'you'}
        ref={el => el && (el.srcObject = stream)}
        style={styles.stageVideo}
      />
      <button style={styles.closeBtn} onClick={onExit}>✕</button>
    </div>
  );
}

/* ---------- inline styles (same as before) ------------------------ */
const styles = {
  wrapper : { padding:16,height:'100vh',display:'flex',flexDirection:'column',
              boxSizing:'border-box',fontFamily:'sans-serif' },
  header  : { display:'flex',gap:12,alignItems:'center',marginBottom:8 },
  grid    : { display:'grid',gap:8,
              gridTemplateColumns:`repeat(auto-fill,minmax(${TILE_W}px,1fr))`,
              flex:1,overflow:'auto' },

  tile    : { position:'relative',width:'100%',paddingTop:'56.25%',
              background:'#000',borderRadius:8,overflow:'hidden',cursor:'pointer' },
  vid     : { position:'absolute',top:0,left:0,width:'100%',height:'100%',
              objectFit:'cover' },
  label   : { position:'absolute',bottom:4,left:6,fontSize:12,
              color:'#fff',background:'#0008',padding:'2px 6px',borderRadius:4 },
  fullBtn : { position:'absolute',top:4,right:4,zIndex:2,
              background:'#0006',color:'#fff',border:'none',
              borderRadius:4,padding:'0 6px' },

  stage   : { position:'relative',flex:1,background:'#000',
              borderRadius:8,overflow:'hidden' },
  stageVideo:{ width:'100%',height:'100%',objectFit:'contain' },
  closeBtn:{ position:'absolute',top:10,right:10,fontSize:24,
             background:'none',border:'none',color:'#fff',cursor:'pointer' },

  shareBox : { position:'relative',width:'100%',paddingTop:'38%',marginBottom:8,
               background:'#000',borderRadius:8,overflow:'hidden' },
  shareVideo:{ position:'absolute',top:0,left:0,width:'100%',height:'100%',
               objectFit:'contain' },
  shareLabel:{ position:'absolute',bottom:4,left:6,fontSize:12,
               color:'#fff',background:'#0008',padding:'2px 6px',borderRadius:4 },
  codeBox : { height:'200px', marginTop:8, borderRadius:8,
              overflow:'hidden', background:'#1e1e1e' }
};
