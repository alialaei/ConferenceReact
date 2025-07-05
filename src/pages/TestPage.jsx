// src/TestPage.jsx

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

function TestPage() {
  const [roomCode, setRoomCode] = useState('');
  const navigate = useNavigate();

  const handleCreateRoom = () => {
    const newRoomId = `room-${Math.random().toString(36).substring(2, 9)}`;
    // For now, we just log the new room ID to the console
    console.log(`Room created: /${newRoomId}`);
    // To navigate directly to the new room, uncomment the line below
    // navigate(`/${newRoomId}`);
  };

  const handleJoinRoom = (e) => {
    e.preventDefault(); // Prevents the form from refreshing the page
    if (roomCode.trim() === '') {
      alert('Please enter a room code first!');
      return;
    }
    console.log(`Joining room: /${roomCode}`);
    // To navigate directly to the joined room, uncomment the line below
    // navigate(`/${roomCode}`);
  };

  return (
    // Dark theme layout with Tailwind CSS classes
    <div className="bg-gray-900 min-h-screen flex flex-col items-center justify-center gap-6 text-center p-8 text-gray-200 font-sans">
      
      <div className="mb-4">
        <h1 className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-purple-500 to-blue-500 text-transparent bg-clip-text">
          Conference App
        </h1>
        <p className="text-gray-400 mt-2">Get connected, share your world.</p>
      </div>

      <button
        onClick={handleCreateRoom}
        className="w-full max-w-xs py-3 px-7 text-base font-bold text-white rounded-lg bg-gradient-to-r from-purple-600 to-blue-600 hover:scale-105 transition-transform duration-200"
      >
        Create New Room
      </button>

      <div className="flex items-center w-full max-w-xs">
        <hr className="w-full border-gray-700" />
        <span className="px-2 text-gray-500 text-sm">OR</span>
        <hr className="w-full border-gray-700" />
      </div>

      <form onSubmit={handleJoinRoom} className="flex gap-2 w-full max-w-xs">
        <input
          type="text"
          value={roomCode}
          onChange={(e) => setRoomCode(e.target.value)}
          className="flex-grow bg-gray-800 border border-gray-700 text-gray-200 p-3 rounded-lg text-base placeholder-gray-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
          placeholder="Enter room code..."
        />
        <button
          type="submit"
          className="py-3 px-5 font-bold bg-gray-700 text-gray-200 rounded-lg hover:bg-gray-600 transition-colors"
        >
          Join
        </button>
      </form>
    </div>
  );
}

export default TestPage;