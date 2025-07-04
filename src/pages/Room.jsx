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
  const [people,   setPeople]   = useState({});          // socketId → { stream }

  const consumers = useRef(new Set());
  const device    = useRef(null);
  const sendT     = useRef(null);
  const recvT     = useRef(null);

  /* ---------- join --------------------------------------------------- */
  useEffect(() => {
    socket.emit('join-room', { roomId }, ({ isOwner }) => {
      setIsOwner(isOwner);
      if (isOwner) setApproved(true); // owner auto-approved
    });
  }, [roomId]);

  /* ---------- socket listeners -------------------------------------- */
  useEffect(() => {
    const approve = ({ socketId }) =>
      window.confirm(`Accept ${socketId}?`)
        ? socket.emit('approve-join', { targetSocketId: socketId })
        : socket.emit('deny-join',    { targetSocketId: socketId });

    const joined = ({ existingProducers }) => {
      setApproved(true);
      initMedia().then(() => existingProducers.forEach(handleProducer));
    };

    socket.on('join-request',  isOwner && approve);
    socket.on('join-approved', joined);
    socket.on('newProducer',   handleProducer);

    socket.on('join-denied', () => alert('Join denied')          || location.replace('/'));
    socket.on('room-closed', () => alert('Room closed by owner') || location.replace('/'));

    return () => socket.off('join-request')
                       .off('join-approved')
                       .off('newProducer');
  }, [isOwner]);

  /* ---------- mediasoup bootstrap ----------------------------------- */
  async function initMedia() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localRef.current.srcObject = stream;

    /* 1. load router caps ------------------------------------------ */
    const rtpCaps = await new Promise(res => socket.emit('getRouterRtpCapabilities', res));
    device.current = new mediasoupClient.Device();
    await device.current.load({ routerRtpCapabilities: rtpCaps });

    /* 2. SEND transport ------------------------------------------- */
    const paramsSend = await new Promise(res => socket.emit('createTransport', res));
    sendT.current = device.current.createSendTransport({
      ...paramsSend,
      iceServers        : paramsSend.iceServers,
      iceTransportPolicy: 'relay'                // <--💡 force TURN
    });

    sendT.current.on('connect', (d, cb) =>
      socket.emit('connectTransport', { transportId: sendT.current.id, dtlsParameters: d }, cb));

    sendT.current.on('produce', (p, cb) =>
      socket.emit('produce', { transportId: sendT.current.id, ...p }, ({ id }) => cb({ id })));

    await Promise.all(stream.getTracks().map(t => sendT.current.produce({ track: t })));

    /* 3. RECV transport ------------------------------------------- */
    const paramsRecv = await new Promise(res => socket.emit('createTransport', res));
    recvT.current = device.current.createRecvTransport({
      ...paramsRecv,
      iceServers        : paramsRecv.iceServers,
      iceTransportPolicy: 'relay'                // <--💡 force TURN
    });

    recvT.current.on('connect', (d, cb) =>
      socket.emit('connectTransport', { transportId: recvT.current.id, dtlsParameters: d }, cb));
  }

  /* ---------- consume helper --------------------------------------- */
  function handleProducer({ producerId, socketId }) {
    if (consumers.current.has(producerId) || !recvT.current) return;
    consumers.current.add(producerId);

    socket.emit('consume',
      { producerId, rtpCapabilities: device.current.rtpCapabilities },
      async ({ id, kind, rtpParameters }) => {
        const consumer = await recvT.current.consume({ id, producerId, kind, rtpParameters });
        setPeople(p => {
          const stream = p[socketId]?.stream ?? new MediaStream();
          stream.addTrack(consumer.track);
          return { ...p, [socketId]: { stream } };
        });
      });
  }

  /* ---------- UI ---------------------------------------------------- */
  return (
    <div style={{ padding: 32 }}>
      <h2>Room {roomId}</h2>
      {isOwner  && !approved && <p>Waiting for guests…</p>}
      {!isOwner && !approved && <p>Waiting for owner approval…</p>}

      <video ref={localRef} autoPlay playsInline muted width={320} style={{ background:'#000' }} />

      {Object.entries(people).map(([id, { stream }]) => (
        <video key={id} autoPlay playsInline width={320}
               ref={el => el && (el.srcObject = stream)} />
      ))}
    </div>
  );
}
