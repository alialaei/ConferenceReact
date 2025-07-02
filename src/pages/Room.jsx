import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const io = new Server(server, {
  cors: {
    origin: ['https://conference.mmup.org'], // add frontend domain here
    methods: ["GET", "POST"],
    credentials: true
  }
});

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
  const remoteVideoRef = useRef();
  const [isOwner, setIsOwner] = useState(false);
  const [approved, setApproved] = useState(false);

  // REGISTER ALL EVENT HANDLERS ONCE
  useEffect(() => {
    // Owner receives join requests and can approve
    socket.on('join-request', ({ socketId }) => {
      if (isOwner) {
        // Prompt or auto-approve for now
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
    });

    socket.on('room-closed', () => {
      alert("Room was closed by the owner.");
    });

    // Clean up listeners on unmount
    return () => {
      socket.off('join-request');
      socket.off('join-approved');
      socket.off('join-denied');
      socket.off('room-closed');
    };
    // eslint-disable-next-line
  }, [isOwner]); // Re-run if isOwner changes

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

  const initMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideoRef.current.srcObject = stream;
      // ...mediasoup logic...
    } catch (err) {
      alert('Could not access camera/microphone. Make sure permissions are granted.');
    }
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
          <h3>Remote</h3>
          <video ref={remoteVideoRef} autoPlay playsInline width={300} />
        </div>
      </div>
    </div>
  );
};

export default Room;
