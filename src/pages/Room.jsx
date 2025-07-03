import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

// Connect to backend
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

  // Map: socketId -> { stream: MediaStream, videoTrack: MediaStreamTrack, audioTrack: MediaStreamTrack }
  const [remoteParticipants, setRemoteParticipants] = useState({});
  const remoteParticipantsRef = useRef({});
  remoteParticipantsRef.current = remoteParticipants;

  const consumedProducers = useRef(new Set());
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  useEffect(() => {
    socket.on('join-request', ({ socketId }) => {
      if (isOwner) {
        if (window.confirm(`Approve user ${socketId}?`)) {
          socket.emit('approve-join', { targetSocketId: socketId });
        } else {
          socket.emit('deny-join', { targetSocketId: socketId });
        }
      }
    });

    socket.on('newProducer', ({ producerId, socketId }) => {
      // Only consume if not already consumed
      if (!consumedProducers.current.has(producerId)) {
        consumedProducers.current.add(producerId);
        consumeProducer(producerId, socketId);
      }
    });

    socket.on('join-approved', (data = {}) => {
      setApproved(true);
      initMedia().then(() => {
        // Consume all existing remote producers
        if (data.existingProducers && data.existingProducers.length) {
          data.existingProducers.forEach(({ producerId, socketId }) => {
            if (!consumedProducers.current.has(producerId)) {
              consumedProducers.current.add(producerId);
              consumeProducer(producerId, socketId);
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
  }, [isOwner]);

  useEffect(() => {
    joinRoom();
    // eslint-disable-next-line
  }, []);

  const joinRoom = () => {
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
          if (response.existingProducers && response.existingProducers.length) {
            response.existingProducers.forEach(({ producerId, socketId }) => {
              if (!consumedProducers.current.has(producerId)) {
                consumedProducers.current.add(producerId);
                consumeProducer(producerId, socketId);
              }
            });
          }
        });
      }
    });
  };

  // ---- Mediasoup setup ----
  const initMedia = async () => {
    try {
      // 1. Get camera/mic
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideoRef.current.srcObject = stream;

      // 2. Create device
      await new Promise(resolve => {
        socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
          const device = new mediasoupClient.Device();
          await device.load({ routerRtpCapabilities: rtpCapabilities });
          deviceRef.current = device;
          resolve();
        });
      });

      // 3. Create send transport (publishing)
      await new Promise(resolve => {
        socket.emit('createTransport', async (params) => {
          const sendTransport = deviceRef.current.createSendTransport(params);

          sendTransport.on('connect', ({ dtlsParameters }, callback) => {
            socket.emit('connectTransport', { transportId: sendTransport.id, dtlsParameters }, callback);
          });

          sendTransport.on('produce', ({ kind, rtpParameters }, callback) => {
            socket.emit('produce', { transportId: sendTransport.id, kind, rtpParameters }, ({ id }) => {
              callback({ id });
            });
          });

          sendTransportRef.current = sendTransport;

          // Publish camera + mic
          for (const track of stream.getTracks()) {
            await sendTransport.produce({ track });
          }
          resolve();
        });
      });

      // 4. Create recv transport (for consuming)
      await new Promise(resolve => {
        socket.emit('createTransport', async (params) => {
          const recvTransport = deviceRef.current.createRecvTransport(params);

          recvTransport.on('connect', ({ dtlsParameters }, callback) => {
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

  // ---- Consume remote producer (group tracks by socketId) ----
  const consumeProducer = (producerId, socketId) => {
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

        setRemoteParticipants(prev => {
          let part = prev[socketId] || { stream: new MediaStream(), videoTrack: null, audioTrack: null };
          if (params.kind === 'video') {
            part.videoTrack = consumer.track;
            part.stream.addTrack(consumer.track);
          } else if (params.kind === 'audio') {
            part.audioTrack = consumer.track;
            part.stream.addTrack(consumer.track);
          }
          return { ...prev, [socketId]: part };
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
          {Object.entries(remoteParticipants).map(([socketId, { stream, videoTrack, audioTrack }]) => (
            <div key={socketId}>
              {videoTrack && (
                <video
                  autoPlay
                  playsInline
                  width={300}
                  ref={el => el && (el.srcObject = stream)}
                  style={{ marginBottom: 8 }}
                />
              )}
              {audioTrack && (
                <audio
                  autoPlay
                  controls={false}
                  ref={el => el && (el.srcObject = stream)}
                  style={{ display: 'none' }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Room;
