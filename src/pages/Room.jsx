import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const socket = io('https://webrtcserver.mmup.org', {
  path: '/socket.io',
  transports: ['websocket']
});

socket.on('connect_error', (err) => {
  console.error('❌ WebSocket connection failed:', err.message);
  alert('Could not connect to server. Please check your network or try again later.');
});

const Room = () => {
  const { roomId } = useParams();
  const localVideoRef = useRef();
  const [isOwner, setIsOwner] = useState(false);
  const [approved, setApproved] = useState(false);

  // Manage remote streams: array of {producerId, stream}
  const [remoteStreams, setRemoteStreams] = useState([]);
  const remoteStreamsRef = useRef([]);
  remoteStreamsRef.current = remoteStreams;

  // Queue for producerIds
  const pendingProducersRef = useRef([]); // [{producerId, socketId}]

  // Mediasoup stuff
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  useEffect(() => {
    // Owner receives join requests and can approve
    socket.on('join-request', ({ socketId }) => {
      if (isOwner) {
        if (window.confirm(`Approve user ${socketId}?`)) {
          socket.emit('approve-join', { targetSocketId: socketId });
        } else {
          socket.emit('deny-join', { targetSocketId: socketId });
        }
      }
    });

    socket.on('join-approved', () => {
      setApproved(true);
      initMedia();
    });

    socket.on('join-denied', () => {
      alert("You were denied access to the room.");
      window.location.href = '/';
    });

    socket.on('room-closed', () => {
      alert("Room was closed by the owner.");
      window.location.href = '/';
    });

    // Listen for new producers (remote users' media)
    socket.on('newProducer', ({ producerId, socketId }) => {
      pendingProducersRef.current.push({ producerId, socketId });
      tryConsumeProducers();
    });

    return () => {
      socket.off('join-request');
      socket.off('join-approved');
      socket.off('join-denied');
      socket.off('room-closed');
      socket.off('newProducer');
    };
  }, [isOwner]);

  useEffect(() => {
    joinRoom();
    // eslint-disable-next-line
  }, []);

  const joinRoom = async () => {
    // Owner marker per room
    const ownerMarkerKey = `room-owner-${roomId}`;
    let isOwnerCandidate = false;
    if (!sessionStorage.getItem(ownerMarkerKey)) {
      isOwnerCandidate = true;
      sessionStorage.setItem(ownerMarkerKey, "1");
    }

    const response = await new Promise(resolve =>
      socket.emit('join-room', { roomId, isOwnerCandidate }, resolve)
    );

    setIsOwner(response.isOwner);

    if (response.isOwner || response.waitForApproval === false) {
      setApproved(true);
      initMedia();
    }
  };

  // ---- Media + Mediasoup setup ----
  const initMedia = async () => {
    try {
      // Get local camera/mic
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideoRef.current.srcObject = stream;

      // --- Setup mediasoup device ---
      socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        deviceRef.current = device;

        // --- Create Send Transport (for publishing local media) ---
        socket.emit('createTransport', async (params) => {
          const sendTransport = device.createSendTransport(params);

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
        });

        // --- Create Recv Transport (for consuming others) ---
        socket.emit('createTransport', async (params) => {
          const recvTransport = device.createRecvTransport(params);

          recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { transportId: recvTransport.id, dtlsParameters }, callback);
          });

          recvTransportRef.current = recvTransport;

          // NOW call this:
          tryConsumeProducers();
        });
      });
    } catch (err) {
      alert('Could not access camera/microphone. Make sure permissions are granted.');
    }
  };

  // Consumes all queued remote producers
  const tryConsumeProducers = () => {
    if (!recvTransportRef.current || !deviceRef.current) return;
    const producersToConsume = pendingProducersRef.current.splice(0, pendingProducersRef.current.length);
    producersToConsume.forEach(({ producerId }) => {
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
