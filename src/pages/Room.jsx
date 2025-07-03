import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

// Use your backend domain
const socket = io('https://webrtcserver.mmup.org', {
  path: '/socket.io',
  transports: ['websocket'],
  autoConnect: true
});

const Room = () => {
  const { roomId } = useParams();
  const localVideoRef = useRef();
  const [isOwner, setIsOwner] = useState(false);
  const [approved, setApproved] = useState(false);

  // For remote video
  const [remoteStreams, setRemoteStreams] = useState([]);
  const remoteStreamsRef = useRef([]);
  remoteStreamsRef.current = remoteStreams;

  // Mediasoup
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  // Buffer for new producers (to avoid race condition)
  const pendingProducersRef = useRef([]);
  // Already consumed producers to avoid double-consuming
  const consumedProducers = useRef(new Set());

  useEffect(() => {
    // OWNER gets join requests
    socket.on('join-request', ({ socketId }) => {
      if (isOwner) {
        if (window.confirm(`Approve user ${socketId}?`)) {
          socket.emit('approve-join', { targetSocketId: socketId });
        } else {
          socket.emit('deny-join', { targetSocketId: socketId });
        }
      }
    });

    // Everyone gets newProducer
    socket.on('newProducer', ({ producerId, socketId }) => {
      // Prevent duplicate consuming
      if (consumedProducers.current.has(producerId)) return;
      consumedProducers.current.add(producerId);
      consumeProducer(producerId);
    });

    socket.on('join-approved', (data = {}) => {
      setApproved(true);
      initMedia().then(() => {
        // For guests: if any producers already exist, consume them
        if (data.existingProducers) {
          data.existingProducers.forEach(({ producerId }) => {
            if (!consumedProducers.current.has(producerId)) {
              consumedProducers.current.add(producerId);
              consumeProducer(producerId);
            }
          });
        }
      });
    });

    socket.on('join-denied', () => {
      alert('You were denied access to the room.');
      window.location.href = '/';
    });

    socket.on('room-closed', () => {
      alert('Room was closed by the owner.');
      window.location.href = '/';
    });

    return () => {
      socket.off('join-request');
      socket.off('join-approved');
      socket.off('join-denied');
      socket.off('room-closed');
      socket.off('newProducer');
    };
    // eslint-disable-next-line
  }, [isOwner]);

  useEffect(() => {
    joinRoom();
    // eslint-disable-next-line
  }, []);

  const joinRoom = async () => {
    const ownerMarkerKey = `room-owner-${roomId}`;
    let isOwnerCandidate = false;
    if (!sessionStorage.getItem(ownerMarkerKey)) {
      isOwnerCandidate = true;
      sessionStorage.setItem(ownerMarkerKey, "1");
    }

    socket.emit('join-room', { roomId }, (response = {}) => {
      setIsOwner(response.isOwner);
      if (response.isOwner || response.waitForApproval === false) {
        setApproved(true);
        initMedia().then(() => {
          if (response.existingProducers) {
            response.existingProducers.forEach(({ producerId }) => {
              if (!consumedProducers.current.has(producerId)) {
                consumedProducers.current.add(producerId);
                consumeProducer(producerId);
              }
            });
          }
        });
      }
    });
  };

  // ---- Media + Mediasoup setup ----
  const initMedia = async () => {
    try {
      // Get local camera/mic
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideoRef.current.srcObject = stream;

      // --- Setup mediasoup device ---
      await new Promise(resolve => {
        socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
          const device = new mediasoupClient.Device();
          await device.load({ routerRtpCapabilities: rtpCapabilities });
          deviceRef.current = device;
          resolve();
        });
      });

      // --- Create Send Transport (for publishing local media) ---
      await new Promise(resolve => {
        socket.emit('createTransport', async (params) => {
          const sendTransport = deviceRef.current.createSendTransport(params);

          sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { transportId: sendTransport.id, dtlsParameters }, callback);
          });

          sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
            socket.emit('produce', { transportId: sendTransport.id, kind, rtpParameters }, ({ id }) => {
              callback({ id });
            });
          });

          sendTransportRef.current = sendTransport;

          // Publish video and audio
          for (const track of stream.getTracks()) {
            await sendTransport.produce({ track });
          }
          resolve();
        });
      });

      // --- Create Recv Transport (for consuming others) ---
      await new Promise(resolve => {
        socket.emit('createTransport', async (params) => {
          const recvTransport = deviceRef.current.createRecvTransport(params);

          recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { transportId: recvTransport.id, dtlsParameters }, callback);
          });

          recvTransportRef.current = recvTransport;
          resolve();
        });
      });
    } catch (err) {
      alert('Could not access camera/microphone. Make sure permissions are granted.');
    }
  };

  // Consume a producer and add to UI
  const consumeProducer = async (producerId) => {
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
        const stream = new MediaStream([consumer.track]);
        setRemoteStreams(prev => {
          // Avoid duplicates
          if (prev.find(r => r.producerId === producerId)) return prev;
          return [...prev, { producerId, stream }];
        });
      }
    });
  };

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
            <video key={producerId} autoPlay playsInline width={300}
              ref={el => el && (el.srcObject = stream)}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default Room;
