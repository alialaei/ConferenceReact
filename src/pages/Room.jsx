// Room.jsx
import { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const socket = io('https://webrtcserver.mmup.org', { transports: ['websocket'] });

export default function Room() {
  const { roomId } = useParams();
  const localRef   = useRef(null);

  const [isOwner,  setIsOwner]  = useState(false);
  const [approved, setApproved] = useState(false);
  const [peers,    setPeers]    = useState({}); // socketId -> {stream}

  const device  = useRef(null);
  const sendT   = useRef(null);
  const recvT   = useRef(null);
  const seen    = useRef(new Set());            // producerIds already consumed

  /* ---------- join once ---------------------------------------------- */
  useEffect(() => {
    socket.emit('join-room', { roomId }, res => {
      setIsOwner(res.isOwner);
      if (res.isOwner) setApproved(true);
    });
  }, [roomId]);

  /* ---------- socket listeners --------------------------------------- */
  useEffect(() => {
    const joinReq = ({ socketId }) => {
      if (!isOwner) return;
      window.confirm(`Accept ${socketId}?`)
        ? socket.emit('approve-join', { targetSocketId: socketId })
        : socket.emit('deny-join',    { targetSocketId: socketId });
    };

    const joinOk  = ({ existingProducers }) => {
      setApproved(true);
      initMedia().then(() => existingProducers.forEach(handleProducer));
    };

    socket.on('join-request',  joinReq)
          .on('join-approved', joinOk)
          .on('newProducer',   handleProducer)
          .on('join-denied',   () => alert('Join denied') || window.location.replace('/'))
          .on('room-closed',   () => alert('Room closed') || window.location.replace('/'));

    return () => socket.off('join-request',  joinReq)
                       .off('join-approved', joinOk)
                       .off('newProducer',   handleProducer);
  }, [isOwner]);

  /* ---------- mediasoup bootstrap ------------------------------------ */
  async function initMedia() {
    /* 1. local camera -------------------------------------------------- */
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (localRef.current) localRef.current.srcObject = stream;

    /* 2. router capabilities ------------------------------------------ */
    const rtpCaps = await new Promise(res => socket.emit('getRouterRtpCapabilities', res));
    device.current = new mediasoupClient.Device();
    await device.current.load({ routerRtpCapabilities: rtpCaps });

    /* 3. send transport ----------------------------------------------- */
    const paramsSend = await new Promise(res => socket.emit('createTransport', res));
    sendT.current = device.current.createSendTransport(paramsSend);

    sendT.current.on('connect',
      ({ dtlsParameters }, cb) => socket.emit(
        'connectTransport', { transportId: sendT.current.id, dtlsParameters }, cb));

    sendT.current.on('produce',
      (p, cb) => socket.emit('produce',
        { transportId: sendT.current.id, ...p }, ({ id }) => cb({ id })));

    await Promise.all(stream.getTracks().map(t => sendT.current.produce({ track: t })));

    /* 4. recv transport ----------------------------------------------- */
    const paramsRecv = await new Promise(res => socket.emit('createTransport', res));
    recvT.current = device.current.createRecvTransport(paramsRecv);

    recvT.current.on('connect',
      ({ dtlsParameters }, cb) => socket.emit(
        'connectTransport', { transportId: recvT.current.id, dtlsParameters }, cb));
  }

  /* ---------- consume helper ----------------------------------------- */
  function handleProducer({ producerId, socketId }) {
    if (!recvT.current || seen.current.has(producerId)) return;
    seen.current.add(producerId);

    socket.emit('consume',
      { producerId, rtpCapabilities: device.current.rtpCapabilities },
      async ({ id, kind, rtpParameters }) => {
        const consumer = await recvT.current.consume({ id, producerId, kind, rtpParameters });
        setPeers(prev => {
          const stream = prev[socketId]?.stream ?? new MediaStream();
          stream.addTrack(consumer.track);
          return { ...prev, [socketId]: { stream } };
        });
      });
  }

  /* ---------- render -------------------------------------------------- */
  return (
    <div style={{ padding: 32 }}>
      <h2>Room {roomId}</h2>
      {isOwner  && !approved && <p>Waiting for guests…</p>}
      {!isOwner && !approved && <p>Waiting for owner approval…</p>}

      <video ref={localRef} autoPlay playsInline muted width={320}
             style={{ background:'#000', marginRight:16 }} />

      {Object.entries(peers).map(([id, { stream }]) => (
        <video key={id} autoPlay playsInline width={320}
               ref={el => el && (el.srcObject = stream)} />
      ))}
    </div>
  );
}
