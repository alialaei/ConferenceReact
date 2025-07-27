import React from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";

// Import both the original and the new page components
import Room from "./pages/Room";
import TestPage from "./pages/TestPage";

const App = () => {
  return (
    <Router>
      <Routes>
        {/* --- Original Routes (Untouched) --- */}
        {/* This route redirects the homepage to a new random room with the OLD design */}
        <Route
          path="/"
          element={<Navigate to={`/room/${generateShortId()}`} />}
        />

        {/* This route handles the OLD room component */}
        <Route path="/room/:roomId" element={<Room />} />

        {/* --- New Test Routes for the Redesigned UI --- */}
        {/* This route shows the LOBBY for the new design */}
        <Route path="/" element={<TestPage />} />

        {/* This route enters a specific room with the NEW design */}
        <Route path="/test/:roomId" element={<TestPage />} />
      </Routes>
    </Router>
  );
};

// Helper function to generate random room IDs for the original route
function generateShortId(length = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export default App;
