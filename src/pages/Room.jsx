import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const socket = io('https://webrtcserver.mmup.org', {
  path: '/socket.io',
  transports: ['websocket'],
});

const Room = () => {
  const { roomId } = useParams();
  const localVideoRef = useRef(null);
  const [isOwner, setIsOwner] = useState(false);
  const [approved, setApproved] = useState(false);

  // For remote video
  const [remoteStreams, setRemoteStreams] = useState([]);
  const consumedProducers = useRef(new Set());

  // Mediasoup device/transports
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  // 1. JOIN room
  useEffect(() => {
    socket.emit('join-room', { roomId }, (res = {}) => {
      setIsOwner(res.isOwner);
      if (res.isOwner || res.waitForApproval === false) {
        setApproved(true);
        startMedia(res.existingProducers || []);
      }
    });
  }, [roomId]);

  // 2. SOCKET event handlers
  useEffect(() => {
    function handleJoinRequest({ socketId }) {
      if (isOwner) {
        if (window.confirm(`Approve user ${socketId}?`)) {
          socket.emit('approve-join', { targetSocketId: socketId });
        } else {
          socket.emit('deny-join', { targetSocketId: socketId });
        }
      }
    }
    function handleNewProducer({ producerId }) {
      if (!consumedProducers.current.has(producerId)) {
        consumedProducers.current.add(producerId);
        consumeProducer(producerId);
      }
    }
    function handleJoinApproved(data = {}) {
      setApproved(true);
      startMedia(data.existingProducers || []);
    }
    socket.on('join-request', handleJoinRequest);
    socket.on('newProducer', handleNewProducer);
    socket.on('join-approved', handleJoinApproved);

    socket.on('join-denied', () => {
      alert('You were denied access to the room.');
      window.location.href = '/';
    });
    socket.on('room-closed', () => {
      alert('Room was closed by the owner.');
      window.location.href = '/';
    });

    return () => {
      socket.off('join-request', handleJoinRequest);
      socket.off('newProducer', handleNewProducer);
      socket.off('join-approved', handleJoinApproved);
      socket.off('join-denied');
      socket.off('room-closed');
    };
  }, [isOwner]);

  // 3. INITIAL MEDIA + SIGNAL
  async function startMedia(existingProducers) {
    // 3.1. Get local camera/mic
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideoRef.current.srcObject = stream;
    } catch (err) {
      alert('Could not access camera/microphone.');
      return;
    }
    // 3.2. Mediasoup Device (must match backend router)
    const rtpCapabilities = await new Promise(res =>
      socket.emit('getRouterRtpCapabilities', res)
    );
    const device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    deviceRef.current = device;

    // 3.3. Create Send Transport, publish all tracks
    await new Promise(res => {
      socket.emit('createTransport', async (params) => {
        const sendTransport = device.createSendTransport(params);

        sendTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
          socket.emit('connectTransport', { transportId: sendTransport.id, dtlsParameters }, cb);
        });
        sendTransport.on('produce', ({ kind, rtpParameters }, cb, eb) => {
          socket.emit('produce', { transportId: sendTransport.id, kind, rtpParameters }, ({ id }) => {
            cb({ id });
          });
        });

        sendTransportRef.current = sendTransport;
        // Publish video and audio
        for (const track of stream.getTracks()) {
          await sendTransport.produce({ track });
        }
        res();
      });
    });

    // 3.4. Create Recv Transport for all remote
    await new Promise(res => {
      socket.emit('createTransport', async (params) => {
        const recvTransport = device.createRecvTransport(params);

        recvTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
          socket.emit('connectTransport', { transportId: recvTransport.id, dtlsParameters }, cb);
        });
        recvTransportRef.current = recvTransport;
        res();
      });
    });

    // 3.5. If already producers in room, consume them!
    if (existingProducers && existingProducers.length) {
      existingProducers.forEach(({ producerId }) => {
        if (!consumedProducers.current.has(producerId)) {
          consumedProducers.current.add(producerId);
          consumeProducer(producerId);
        }
      });
    }
  }

  // 4. Consume remote tracks
  function consumeProducer(producerId) {
    if (!recvTransportRef.current || !deviceRef.current) return;
    const { rtpCapabilities } = deviceRef.current;
    socket.emit('consume', { producerId, rtpCapabilities }, async (params) => {
      if (params && params.id) {
        const consumer = await recvTransportRef.current.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters
        });
        await consumer.resume();
        const stream = new MediaStream([consumer.track]);
        setRemoteStreams(prev => (
          prev.find(r => r.producerId === producerId) ? prev : [...prev, { producerId, stream }]
        ));
      }
    });
  }

  // 5. Render
  return (
    <div style={{ padding: '2rem' }}>
      <h1>🔗 Room: {roomId}</h1>
      {isOwner && <p>You are the owner. Waiting for guests...</p>}
      {!isOwner && !approved && <p>Waiting for owner's approval...</p>}
      <div style={{ display: 'flex', gap: '2rem', marginTop: '2rem' }}>
        <div>
          <h3>Your Camera</h3>
          <video ref={localVideoRef} autoPlay playsInline muted width={300} />
        </div>
        <div>
          <h3>Remote Participants</h3>
          {remoteStreams.map(({ producerId, stream }) => (
            <video
              key={producerId}
              autoPlay
              playsInline
              width={300}
              ref={el => el && (el.srcObject = stream)}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default Room;
