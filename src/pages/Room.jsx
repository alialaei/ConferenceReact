import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

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

  // socketId -> { stream, videoTrack, audioTrack }
  const [remoteParticipants, setRemoteParticipants] = useState({});
  const consumedProducers = useRef(new Set());
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  useEffect(() => {
    console.log("Setting up socket listeners");

    socket.on('join-request', ({ socketId }) => {
      console.log('[join-request]', socketId);
      if (isOwner) {
        if (window.confirm(`Approve user ${socketId}?`)) {
          socket.emit('approve-join', { targetSocketId: socketId });
        } else {
          socket.emit('deny-join', { targetSocketId: socketId });
        }
      }
    });

    socket.on('newProducer', ({ producerId, socketId }) => {
      console.log('[newProducer]', producerId, socketId);
      if (!consumedProducers.current.has(producerId)) {
        consumedProducers.current.add(producerId);
        consumeProducer(producerId, socketId);
      }
    });

    socket.on('join-approved', (data = {}) => {
      console.log('[join-approved]', data);
      setApproved(true);
      initMedia().then(() => {
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
    if (!sessionStorage.getItem(ownerMarkerKey)) {
      sessionStorage.setItem(ownerMarkerKey, "1");
    }
    console.log('Joining room', roomId);
    socket.emit('join-room', { roomId }, (response = {}) => {
      console.log('[join-room cb]', response);
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
      console.log('Got local stream', stream);

      // 2. Create device
      await new Promise(resolve => {
        socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
          console.log('Got routerRtpCapabilities', rtpCapabilities);
          const device = new mediasoupClient.Device();
          await device.load({ routerRtpCapabilities: rtpCapabilities });
          deviceRef.current = device;
          resolve();
        });
      });

      // 3. Create send transport (publishing)
      await new Promise(resolve => {
        socket.emit('createTransport', async (params) => {
          console.log('Creating sendTransport', params);
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
            console.log('Produced track', track);
          }
          resolve();
        });
      });

      // 4. Create recv transport (for consuming)
      await new Promise(resolve => {
        socket.emit('createTransport', async (params) => {
          console.log('Creating recvTransport', params);
          const recvTransport = deviceRef.current.createRecvTransport(params);

          recvTransport.on('connect', ({ dtlsParameters }, callback) => {
            socket.emit('connectTransport', { transportId: recvTransport.id, dtlsParameters }, callback);
          });

          recvTransportRef.current = recvTransport;
          resolve();
        });
      });
      console.log('initMedia done');
    } catch (err) {
      alert('Could not access camera/microphone. Make sure permissions are granted.');
      console.error('initMedia error', err);
    }
  };

  // ---- Consume remote producer (group tracks by socketId) ----
  const consumeProducer = (producerId, socketId) => {
    if (!recvTransportRef.current || !deviceRef.current) {
      console.log('[consumeProducer] recvTransport or device missing');
      return;
    }
    const { rtpCapabilities } = deviceRef.current;
    console.log('[consumeProducer] for', producerId, 'from', socketId, rtpCapabilities);
    socket.emit('consume', { producerId, rtpCapabilities }, async (params) => {
      console.log('[consume cb]', params);
      if (params && params.id) {
        const consumer = await recvTransportRef.current.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters
        });

        setRemoteParticipants(prev => {
          // Create or clone participant object for socketId
          let part = prev[socketId] || { stream: new MediaStream(), videoTrack: null, audioTrack: null };
          // Only add track if not already present
          if (params.kind === 'video' && !part.stream.getVideoTracks().some(t => t.id === consumer.track.id)) {
            part.videoTrack = consumer.track;
            part.stream.addTrack(consumer.track);
            console.log('Added video track to', socketId);
          }
          if (params.kind === 'audio' && !part.stream.getAudioTracks().some(t => t.id === consumer.track.id)) {
            part.audioTrack = consumer.track;
            part.stream.addTrack(consumer.track);
            console.log('Added audio track to', socketId);
          }
          return { ...prev, [socketId]: part };
        });
      }
    });
  };

  useEffect(() => {
    // Debug log on every remote participant change
    console.log("RemoteParticipants changed:", remoteParticipants);
  }, [remoteParticipants]);

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
                  key={videoTrack.id}
                  autoPlay
                  playsInline
                  width={300}
                  ref={el => {
                    if (el && stream) {
                      el.srcObject = stream;
                      el.muted = false;
                      el.onloadedmetadata = () => { el.play().catch(() => {}); };
                    }
                  }}
                  style={{ background: "#000", marginBottom: 8 }}
                />
              )}
              {audioTrack && (
                <audio
                  key={audioTrack.id}
                  autoPlay
                  controls
                  ref={el => {
                    if (el && stream) {
                      el.srcObject = stream;
                      el.muted = false;
                      el.onloadedmetadata = () => { el.play().catch(() => {}); };
                    }
                  }}
                  style={{ display: 'block', marginTop: 4 }}
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
