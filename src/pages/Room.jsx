import { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const socket = io('https://webrtcserver.mmup.org', { transports:['websocket'] });

export default function Room() {
  const { roomId } = useParams();

  const localRef = useRef(null);
  const [isOwner,  setIsOwner]  = useState(false);
  const [approved, setApproved] = useState(false);
  const [people,   setPeople]   = useState({});        // socketId → { stream }

  const consumers = useRef(new Set());
  const pending   = useRef([]);                         // producers queued before recvT
  const device    = useRef(null);
  const sendT     = useRef(null);
  const recvT     = useRef(null);

  /* ---------- join -------------------------------------------------- */
  useEffect(() => {
    socket.emit('join-room', { roomId }, (r = {}) => {
      setIsOwner(r.isOwner);
      if (r.isOwner || r.waitForApproval === false) {
        setApproved(true);
        initMedia();
      }
    });
  }, [roomId]);

  /* ---------- socket listeners ------------------------------------- */
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

    socket.on('join-denied', () => { alert('Join denied');  location.replace('/'); });
    socket.on('room-closed', () => { alert('Room closed');  location.replace('/'); });

    return () => socket.off('join-request')
                       .off('join-approved')
                       .off('newProducer');
  }, [isOwner]);

  /* ---------- mediasoup bootstrap ---------------------------------- */
  async function initMedia() {
    if (sendT.current) return;                          // already initialised

    /* local camera */
    const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    localRef.current.srcObject = stream;

    /* device & router caps */
    const routerCaps = await new Promise(res =>
      socket.emit('getRouterRtpCapabilities', res));
    device.current = new mediasoupClient.Device();
    await device.current.load({ routerRtpCapabilities: routerCaps });

    /* ---------- SEND transport ------------------------------------ */
    const paramsSend = await new Promise(res =>
      socket.emit('createTransport', { consuming:false }, res));
    sendT.current = device.current.createSendTransport({
      ...paramsSend,
      iceServers        : paramsSend.iceServers,
      iceTransportPolicy: 'relay'
    });

    sendT.current.on(
      'connect',
      async ({ dtlsParameters }, callback, errback) => {
        socket.emit(
          'connectTransport',
          { transportId: sendT.current.id, dtlsParameters },
          (ack) => ack?.error ? errback(ack.error) : callback()
        );
      }
    );

    sendT.current.on(
      'produce',
      ({ kind, rtpParameters }, callback, errback) => {
        socket.emit(
          'produce',
          { transportId: sendT.current.id, kind, rtpParameters },
          ({ id, error }) => error ? errback(error) : callback({ id })
        );
      }
    );

    /* publish audio & video */
    await Promise.all(stream.getTracks().map(t => sendT.current.produce({ track:t })));

    /* ---------- RECV transport ------------------------------------ */
    const paramsRecv = await new Promise(res =>
      socket.emit('createTransport', { consuming:true }, res));
    recvT.current = device.current.createRecvTransport({
      ...paramsRecv,
      iceServers        : paramsRecv.iceServers,
      iceTransportPolicy: 'relay'
    });

    recvT.current.on(
      'connect',
      ({ dtlsParameters }, callback, errback) => {
        socket.emit(
          'connectTransport',
          { transportId: recvT.current.id, dtlsParameters },
          (ack) => ack?.error ? errback(ack.error) : callback()
        );
      }
    );

    /* consume anything queued while recvT was not ready */
    while (pending.current.length) consumeProducer(pending.current.shift());
  }

  /* ---------- producer helper ------------------------------------- */
  function handleProducer(info) {
    if (!recvT.current) { pending.current.push(info); return; }
    consumeProducer(info);
  }

  function consumeProducer({ producerId, socketId }) {
    if (consumers.current.has(producerId)) return;
    consumers.current.add(producerId);

    socket.emit(
      'consume',
      { producerId, rtpCapabilities: device.current.rtpCapabilities },
      async ({ id, kind, rtpParameters, error }) => {
        if (error) { console.error('consume error:', error); return; }
        const consumer = await recvT.current.consume({ id, producerId, kind, rtpParameters });
        await consumer.resume();

        setPeople(p => {
          const stream = p[socketId]?.stream ?? new MediaStream();
          stream.addTrack(consumer.track);
          return { ...p, [socketId]: { stream } };
        });
      }
    );
  }

  /* ---------- UI --------------------------------------------------- */
  return (
    <div style={{ padding:32 }}>
      <h2>Room {roomId}</h2>
      {isOwner  && !approved && <p>Waiting for guests…</p>}
      {!isOwner && !approved && <p>Waiting for owner approval…</p>}

      <video ref={localRef}
             autoPlay playsInline muted width={320}
             style={{ background:'#000' }} />

      {Object.entries(people).map(([id, { stream }]) => (
        <video key={id} autoPlay playsInline width={320}
               ref={el => el && (el.srcObject = stream)} />
      ))}
    </div>
  );
}
