import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Room from './pages/Room';
import TestPage from './pages/TestPage';

const App = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Navigate to={`/room/${generateShortId()}`} />} />
        <Route path="/test" element={<TestPage />} />
        <Route path="/room/:roomId" element={<Room />} />
      </Routes>
    </Router>
  );
};

function generateShortId(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export default App;