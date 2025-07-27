import * as mediasoup from "mediasoup-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import io from "socket.io-client";
import { python } from "@codemirror/lang-python";
import { loadPyodide } from "pyodide";
import { Play as PlayIcon, Code as CodeIcon } from "lucide-react";

import { javascript } from "@codemirror/lang-javascript";
import { okaidia } from "@uiw/codemirror-theme-okaidia";
import CodeMirror from "@uiw/react-codemirror";

// --- ICONS from lucide-react ---
import {
  Keyboard,
  MessageCircle,
  MessageCircleOff,
  Mic,
  MicOff,
  PhoneOff,
  PlusSquare,
  ScreenShare,
  UserCheck,
  UserX,
  Users,
  Video,
  VideoOff,
  X,
} from "lucide-react";

// --- Socket and Mediasoup Setup ---
const socket = io("https://webrtcserver.mmup.org", {
  autoConnect: false,
  transports: ["websocket"],
});

/* ──────────────────────────────────────────────────────────────────── */
/*  Presentational Components                                        */
/* ──────────────────────────────────────────────────────────────────── */

function ApprovalModal({ requests, onApprove, onDeny }) {
  if (requests.length === 0) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]">
      <div className="bg-gray-800 rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
        <h2 className="text-2xl font-bold text-white mb-4">Join Requests</h2>
        <div className="space-y-4 max-h-80 overflow-y-auto">
          {requests.map((req) => (
            <div
              key={req.socketId}
              className="flex items-center justify-between bg-gray-700 p-3 rounded-lg"
            >
              <span className="text-white font-medium">
                {req.nick || `User-${req.socketId.slice(0, 4)}`}
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => onDeny(req.socketId)}
                  className="p-2 rounded-full bg-red-600/20 text-red-400 hover:bg-red-600/40 hover:text-red-300 transition-colors"
                >
                  <UserX size={20} />
                </button>
                <button
                  onClick={() => onApprove(req.socketId)}
                  className="p-2 rounded-full bg-green-600/20 text-green-400 hover:bg-green-600/40 hover:text-green-300 transition-colors"
                >
                  <UserCheck size={20} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ParticipantTile({
  peerId,
  nick,
  stream,
  refEl,
  onStage,
  isLocal,
  isOwner,
  permissions,
  onToggleChat,
}) {
  return (
    <div className="p-2 bg-gray-700/50 rounded-lg">
      <div
        className="relative aspect-video bg-black rounded-md overflow-hidden cursor-pointer group"
        onClick={onStage}
      >
        <video
          ref={(el) => {
            if (refEl) refEl.current = el;
            if (el && stream) el.srcObject = stream;
          }}
          autoPlay
          playsInline
          muted={isLocal} // Only mute your own video to prevent echo
          className="w-full h-full object-cover"
        />
        <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
          <span className="text-white text-sm font-medium">{nick}</span>
        </div>
        <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="text-white font-bold">Click to focus</span>
        </div>
      </div>
      {/* --- Owner Controls --- */}
      {isOwner && !isLocal && (
        <div className="flex items-center justify-end gap-2 mt-2 px-1">
          <button
            onClick={() => onToggleChat(peerId)}
            className="text-gray-300 hover:text-white transition-colors"
            title={permissions?.canChat ? "Disable Chat" : "Enable Chat"}
          >
            {permissions?.canChat ? (
              <MessageCircle size={18} />
            ) : (
              <MessageCircleOff size={18} className="text-red-500" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function ControlBar({
  onToggleMic,
  micOn,
  onToggleCam,
  camOn,
  onShare,
  onLeave,
  isSharing,
  toggleCode,
}) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 md:gap-4 bg-gray-800/80 backdrop-blur-sm p-2 md:p-3 rounded-full shadow-lg z-50">
      <button
        onClick={onToggleMic}
        className={`p-3 rounded-full transition-colors ${
          micOn
            ? "bg-blue-600 hover:bg-blue-700"
            : "bg-red-600 hover:bg-red-700"
        }`}
      >
        {micOn ? <Mic size={20} /> : <MicOff size={20} />}
      </button>
      <button
        onClick={onToggleCam}
        className={`p-3 rounded-full transition-colors ${
          camOn
            ? "bg-blue-600 hover:bg-blue-700"
            : "bg-red-600 hover:bg-red-700"
        }`}
      >
        {camOn ? <Video size={20} /> : <VideoOff size={20} />}
      </button>
      <button
        onClick={onShare}
        disabled={isSharing}
        className="p-3 rounded-full bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 disabled:cursor-not-allowed transition-colors"
      >
        <ScreenShare size={20} />
      </button>
      <button
        onClick={onLeave}
        className="p-3 rounded-full bg-red-600 hover:bg-red-700 transition-colors"
      >
        <PhoneOff size={20} />
      </button>
      <button
        onClick={toggleCode}
        className="p-3 rounded-full bg-purple-600 hover:bg-purple-700 transition-colors md:hidden"
      >
        <CodeIcon size={20} />
      </button>
    </div>
  );
}

function Chat({ roomId, nick, isChatEnabled, isOpen, onClose }) {
  const [messages, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const chatLogRef = useRef(null);

  useEffect(() => {
    const handleMessage = (m) => {
      setMsgs((v) => [...v, m]);
    };
    socket.on("chat-recv", handleMessage);
    return () => socket.off("chat-recv", handleMessage);
  }, []);

  useEffect(() => {
    if (chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
    }
  }, [messages]);

  const send = () => {
    if (!text.trim() || !isChatEnabled) return;
    // The server is the single source of truth.
    // It will receive this event and broadcast the message back to all clients, including the sender.
    socket.emit("chat-send", { roomId, text, from: nick });
    setText("");
  };

  return (
    <div
      className={`fixed top-0 bottom-0 h-full transition-transform duration-300 ease-in-out z-[60] w-full max-w-sm md:w-80 md:relative md:translate-x-0 ${
        isOpen ? "translate-x-0" : "translate-x-full"
      } right-0 flex flex-col bg-gray-900/80 backdrop-blur-md p-4 text-white shadow-xl`}
    >
      <div className="flex justify-between items-center mb-2 border-b border-gray-600 pb-2">
        <h3 className="font-bold">Chat</h3>
        <button
          onClick={onClose}
          className="md:hidden text-gray-400 hover:text-white"
        >
          <X size={24} />
        </button>
      </div>
      <div ref={chatLogRef} className="flex-1 overflow-y-auto mb-4 pr-2">
        {messages.map((m, i) => (
          <div key={i} className="mb-2 break-words">
            <b
              className={m.from === nick ? "text-blue-400" : "text-purple-400"}
            >
              {m.from === nick ? "You" : m.from}:
            </b>{" "}
            {m.text}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 bg-gray-700 border border-gray-600 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-800 disabled:cursor-not-allowed"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={
            isChatEnabled ? "Type a message..." : "Chat is disabled for you"
          }
          disabled={!isChatEnabled}
        />
        <button
          onClick={send}
          className="bg-blue-600 hover:bg-blue-700 rounded-md px-4 font-bold disabled:bg-gray-600"
          disabled={!isChatEnabled}
        >
          ➤
        </button>
      </div>
    </div>
  );
}

function CodeEditor({ roomId, editable }) {
  const [code, setCode] = useState("// Loading code...");
  const [language, setLanguage] = useState("javascript");
  const [output, setOutput] = useState("");
  const [pyodide, setPyodide] = useState(null);

  useEffect(() => {
    async function initPyodide() {
      const py = await loadPyodide();
      setPyodide(py);
    }
    initPyodide();
  }, []);

  useEffect(() => {
    socket.emit("code-get", { roomId }, (text) =>
      setCode(text || "// Start coding here!")
    );
  }, [roomId]);

  useEffect(() => {
    const handleUpdate = ({ text }) => setCode(text);
    socket.on("code-update", handleUpdate);
    return () => socket.off("code-update", handleUpdate);
  }, []);

  const onChange = useCallback(
    (val) => {
      setCode(val);
      socket.emit("code-set", { roomId, text: val });
    },
    [roomId]
  );

  const runCode = async () => {
    if (language === "javascript") {
      try {
        let logs = [];
        const originalLog = console.log;
        console.log = (...args) => {
          logs.push(args.join(" "));
          originalLog(...args);
        };

        const result = eval(code);
        console.log = originalLog;

        setOutput(logs.length ? logs.join("\n") : String(result));
      } catch (e) {
        setOutput("Error: " + e.message);
      }
    } else if (language === "python") {
      if (!pyodide) {
        setOutput("Python is still loading...");
        return;
      }
      try {
        const result = await pyodide.runPythonAsync(code);
        setOutput(String(result));
      } catch (e) {
        setOutput("Error: " + e.message);
      }
    }
    // else if (language === "php") {
    //   setOutput("PHP execution not implemented yet.");
    // }
  };

  return (
    <div className="h-full w-full rounded-lg overflow-hidden bg-[#272822] flex flex-col">
      <div className="flex items-center gap-2 p-2 bg-gray-800">
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="p-1 rounded bg-gray-700"
        >
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          {/* <option value="php">PHP</option> */}
        </select>
        <button
          onClick={runCode}
          className="flex items-center gap-1 bg-green-600 hover:bg-green-700 px-3 py-1 rounded text-sm"
        >
          <PlayIcon size={16} /> Run
        </button>
      </div>
      <CodeMirror
        value={code}
        height="100%"
        theme={okaidia}
        extensions={[
          language === "python"
            ? python()
            : javascript() // fallback for JS and PHP
        ]}
        readOnly={!editable}
        onChange={editable ? onChange : undefined}
      />
      <div className="p-2 text-xs bg-gray-900 text-white min-h-[40px]">
        {output}
      </div>
    </div>
  );
}


function HomePageLobby({ onCreate, onJoin }) {
  const [joinCode, setJoinCode] = useState("");
  const [nick, setNick] = useState("");
  const [slug, setSlug] = useState("");

  const handleJoinClick = () => {
    if (!joinCode.trim()) {
      alert("Please enter a room code to join.");
      return;
    }
    if (!nick.trim()) {
      alert("Please enter your name.");
      return;
    }
    onJoin({ nick, roomId: joinCode });
  };

  const handleCreateClick = () => {
    if (!nick.trim()) {
      alert("Please enter your name.");
      return;
    }
    const newRoomId =
      slug.trim().replace(/\s+/g, "-") ||
      Math.random().toString(36).substring(2, 11);
    onCreate({ nick, roomId: newRoomId });
  };

  return (
    <div className="bg-gray-900 min-h-screen flex items-center justify-center text-white p-4">
      <div className="w-full max-w-5xl grid md:grid-cols-2 gap-8 md:gap-16 items-center">
        <div className="space-y-8">
          <h1 className="text-4xl md:text-5xl font-extrabold leading-tight">
            Premium video meetings. Now free for everyone.
          </h1>
          <p className="text-gray-400 text-lg">
            We re-engineered the service we built for secure business meetings,
            Conference App, to make it free and available for all.
          </p>
          <div className="space-y-4">
            <input
              type="text"
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              placeholder="Enter your name"
            />
            <div className="flex items-center gap-2 p-1 bg-gray-800 border border-gray-700 rounded-lg focus-within:ring-2 focus-within:ring-purple-500">
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="flex-1 bg-transparent px-3 py-2 focus:outline-none"
                placeholder="Custom slug (optional)"
              />
              <button
                onClick={handleCreateClick}
                className="flex items-center justify-center gap-2 py-2 px-4 rounded-md text-base font-medium text-white bg-purple-600 hover:bg-purple-700 transition-colors"
              >
                <PlusSquare size={20} /> New meeting
              </button>
            </div>

            <div className="relative flex items-center justify-center text-gray-500">
              <hr className="w-full border-gray-700" />
              <span className="absolute bg-gray-900 px-2">OR</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative flex-grow">
                <Keyboard
                  size={20}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
                />
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                  placeholder="Enter a code or link"
                />
              </div>
              <button
                onClick={handleJoinClick}
                disabled={!joinCode}
                className="py-3 px-6 font-medium text-white rounded-lg bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
              >
                Join
              </button>
            </div>
          </div>
        </div>
        <div className="hidden md:flex items-center justify-center">
          <img
            src="https://www.gstatic.com/meet/user_edu_get_a_link_light_90698cd7b4ca04d3005c962a3756c42d.svg"
            alt="Video conference illustration"
            className="w-full h-auto"
          />
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Main Component (Router)                                           */
/* ──────────────────────────────────────────────────────────────────── */
export default function TestPage() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const device = useRef(null);
  const sendT = useRef(null);
  const recvT = useRef(null);
  const consumers = useRef(new Set());
  const pendingProducers = useRef([]);
  const audioProducer = useRef(null);
  const videoProducer = useRef(null);
  const shareProducer = useRef(null);
  const isOwnerRef = useRef(false);

  const [people, setPeople] = useState({});
  const [share, setShare] = useState(null);
  const [stageId, setStageId] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [isConnecting, setIsConnecting] = useState(true);
  const [isStreamReady, setIsStreamReady] = useState(false);
  const [myPermissions, setMyPermissions] = useState({ canChat: true });
  const [pendingRequests, setPendingRequests] = useState([]);
  const [isParticipantsOpen, setParticipantsOpen] = useState(false);
  const [isChatOpen, setChatOpen] = useState(false);

  const nick = location.state?.nick || "Guest";

  const [isCodeOpen, setIsCodeOpen] = useState(false);

  const handleCreateMeeting = ({ nick, roomId }) => {
    navigate(`/test/${roomId}`, { state: { nick } });
  };

  const handleJoinMeeting = ({ nick, roomId }) => {
    navigate(`/test/${roomId}`, { state: { nick } });
  };

  const handleToggleChatPermission = (targetSocketId) => {
    setPeople((prevPeople) => {
      const targetPerson = prevPeople[targetSocketId];
      if (!targetPerson) return prevPeople;
      const newPermissions = {
        ...targetPerson.permissions,
        canChat: !targetPerson.permissions.canChat,
      };
      console.log(
        `(Client-side only) Toggling chat for ${targetSocketId} to ${newPermissions.canChat}`
      );
      return {
        ...prevPeople,
        [targetSocketId]: { ...targetPerson, permissions: newPermissions },
      };
    });
  };

  const handleApproveRequest = (targetSocketId) => {
    socket.emit("approve-join", { targetSocketId });
    setPendingRequests((prev) =>
      prev.filter((req) => req.socketId !== targetSocketId)
    );
  };

  const handleDenyRequest = (targetSocketId) => {
    socket.emit("deny-join", { targetSocketId });
    setPendingRequests((prev) =>
      prev.filter((req) => req.socketId !== targetSocketId)
    );
  };

  const cleanup = useCallback(() => {
    console.log("Cleaning up previous room state...");
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (sendT.current) sendT.current.close();
    if (recvT.current) recvT.current.close();
    if (socket.connected) socket.disconnect();

    device.current = null;
    sendT.current = null;
    recvT.current = null;
    audioProducer.current = null;
    videoProducer.current = null;
    shareProducer.current = null;
    consumers.current.clear();
    pendingProducers.current = [];
    isOwnerRef.current = false;

    setPeople({});
    setShare(null);
    setStageId(null);
    setMicOn(true);
    setCamOn(true);
    setIsConnecting(true);
    setIsStreamReady(false);
    setMyPermissions({ canChat: true });
    setPendingRequests([]);
  }, []);

  useEffect(() => {
    if (!roomId) {
      setIsConnecting(false);
      return;
    }

    socket.connect();

    socket.emit("join-room", { roomId, nick }, (r = {}) => {
      isOwnerRef.current = r.isOwner;
      if (r.isOwner || r.waitForApproval === false) {
        initMedia();
      }
      setIsConnecting(false);
    });

    const handleJoinRequest = ({ socketId, nick }) => {
      if (isOwnerRef.current) {
        setPendingRequests((prev) => {
          if (prev.some((req) => req.socketId === socketId)) return prev;
          return [...prev, { socketId, nick }];
        });
      }
    };

    const joined = ({ existingProducers }) => {
      initMedia().then(() => existingProducers.forEach(handleProducer));
    };

    const handleParticipantLeft = ({ socketId }) => {
      setPeople((p) => {
        const copy = { ...p };
        delete copy[socketId];
        return copy;
      });
      if (share && share.socketId === socketId) setShare(null);
      if (stageId === socketId) setStageId("you");
    };

    socket.on("join-request", handleJoinRequest);
    socket.on("join-approved", joined);
    socket.on("newProducer", handleProducer);
    socket.on("screen-stopped", () => setShare(null));
    socket.on("participant-left", handleParticipantLeft);
    socket.on("join-denied", () => {
      alert("Join denied");
      navigate("/test");
    });
    socket.on("room-closed", () => {
      alert("Room closed");
      navigate("/test");
    });

    return () => {
      socket.off("join-request", handleJoinRequest);
      cleanup();
    };
  }, [roomId, cleanup]);

  async function initMedia() {
    if (sendT.current) return;

    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      localStreamRef.current = cam;
      setIsStreamReady(true);
      setStageId("you");

      const caps = await new Promise((r) =>
        socket.emit("getRouterRtpCapabilities", r)
      );
      device.current = new mediasoup.Device();
      await device.current.load({ routerRtpCapabilities: caps });

      const sendTransportParams = await new Promise((r) =>
        socket.emit("createTransport", { consuming: false }, r)
      );
      sendT.current = device.current.createSendTransport(sendTransportParams);

      sendT.current.on("connect", ({ dtlsParameters }, ok, bad) =>
        socket.emit(
          "connectTransport",
          { transportId: sendT.current.id, dtlsParameters },
          (a) => (a?.error ? bad(a.error) : ok())
        )
      );
      sendT.current.on("produce", ({ kind, rtpParameters, appData }, ok, bad) =>
        socket.emit(
          "produce",
          { transportId: sendT.current.id, kind, rtpParameters, appData },
          ({ id, error }) => (error ? bad(error) : ok({ id }))
        )
      );

      const videoTrack = cam.getVideoTracks()[0];
      const audioTrack = cam.getAudioTracks()[0];
      if (audioTrack)
        audioProducer.current = await sendT.current.produce({
          track: audioTrack,
          appData: { mediaTag: "mic" },
        });
      if (videoTrack)
        videoProducer.current = await sendT.current.produce({
          track: videoTrack,
          appData: { mediaTag: "cam" },
        });

      const recvTransportParams = await new Promise((r) =>
        socket.emit("createTransport", { consuming: true }, r)
      );
      recvT.current = device.current.createRecvTransport(recvTransportParams);

      recvT.current.on("connect", ({ dtlsParameters }, ok, bad) =>
        socket.emit(
          "connectTransport",
          { transportId: recvT.current.id, dtlsParameters },
          (a) => (a?.error ? bad(a.error) : ok())
        )
      );

      while (pendingProducers.current.length)
        consumeProducer(pendingProducers.current.shift());
    } catch (error) {
      console.error("Error initializing media:", error);
      alert(
        "Could not access camera or microphone. Please check permissions and try again."
      );
    }
  }

  function handleProducer(info) {
    if (!recvT.current) {
      pendingProducers.current.push(info);
      return;
    }
    consumeProducer(info);
  }

  async function consumeProducer(info) {
    const { producerId, socketId, mediaTag, nick: producerNick } = info;
    if (consumers.current.has(producerId)) return;

    const rtpCapabilities = device.current.rtpCapabilities;
    socket.emit("consume", { producerId, rtpCapabilities }, async (params) => {
      if (params.error) return console.error("Consume error:", params.error);
      const consumer = await recvT.current.consume(params);
      consumers.current.add(producerId);
      const { track } = consumer;
      const isScreen = mediaTag === "screen";

      const clearShare = () =>
        setShare((s) => (s && s.socketId === socketId ? null : s));
      consumer.on("producerclose", clearShare);
      track.onended = clearShare;

      if (isScreen) {
        setShare({ socketId, stream: new MediaStream([track]) });
      } else {
        setPeople((p) => {
          const existingStream = p[socketId]?.stream || new MediaStream();
          existingStream.addTrack(track);
          return {
            ...p,
            [socketId]: {
              stream: existingStream,
              nick: producerNick || `Peer-${socketId.slice(0, 4)}`,
              permissions: { canChat: true },
            },
          };
        });
      }
    });
  }

  const toggleMic = () => {
    const p = audioProducer.current;
    if (!p) return;
    p.paused ? p.resume() : p.pause();
    setMicOn(!p.paused);
  };

  const toggleCam = () => {
    const p = videoProducer.current;
    if (!p) return;
    p.paused ? p.resume() : p.pause();
    setCamOn(!p.paused);
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks()[0].enabled = !p.paused;
    }
  };

  const startShare = async () => {
    if (share) return;
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      const track = displayStream.getVideoTracks()[0];
      track.onended = () => stopShare();
      shareProducer.current = await sendT.current.produce({
        track,
        appData: { mediaTag: "screen" },
      });
      setShare({ socketId: "you", stream: displayStream });
    } catch (err) {
      console.error("Screen share error:", err);
    }
  };

  const stopShare = () => {
    if (!shareProducer.current) return;
    shareProducer.current.close();
    shareProducer.current = null;
    setShare(null);
    socket.emit("stop-screen");
  };

  const leaveRoom = () => {
    navigate("/test");
  };

  const currentStageStream =
    stageId === "you" ? localStreamRef.current : people[stageId]?.stream;

  if (!roomId) {
    return (
      <HomePageLobby
        onCreate={handleCreateMeeting}
        onJoin={handleJoinMeeting}
      />
    );
  }

  if (isConnecting) {
    return (
      <div className="bg-gray-900 min-h-screen flex items-center justify-center text-white text-xl">
        Connecting to room...
      </div>
    );
  }

  return (
    <div className="bg-gray-900 text-white h-screen w-screen flex flex-col">
      <ApprovalModal
        requests={pendingRequests}
        onApprove={handleApproveRequest}
        onDeny={handleDenyRequest}
      />
      <header className="p-4 border-b border-gray-800 flex justify-between items-center flex-shrink-0">
        <h3 className="font-bold text-lg md:text-xl truncate">
          Room: {roomId}
        </h3>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setParticipantsOpen((v) => !v)}
            className="md:hidden text-gray-300 hover:text-white"
          >
            <Users size={24} />
          </button>
          <button
            onClick={() => setChatOpen((v) => !v)}
            className="md:hidden text-gray-300 hover:text-white"
          >
            <MessageCircle size={24} />
          </button>
        </div>
      </header>
      <div className="flex flex-1 min-h-0">
        {" "}
        {/* Added min-h-0 here */}
        <main className="flex-1 flex flex-col p-2 md:p-4 gap-4 min-w-0">
          {" "}
          {/* Added min-w-0 here */}
          <div className="flex-1 relative bg-black rounded-lg overflow-hidden">
            {currentStageStream ? (
              <video
                key={stageId}
                ref={(el) => el && (el.srcObject = currentStageStream)}
                autoPlay
                playsInline
                muted={stageId === "you"}
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-500">
                <p>Select a participant to view on stage</p>
              </div>
            )}
          </div>
          <div className="h-1/3 hidden md:block">
            <CodeEditor roomId={roomId} editable={isOwnerRef.current} />
          </div>
          {isCodeOpen && (
            <div className="h-1/3 md:hidden">
              <CodeEditor roomId={roomId} editable={isOwnerRef.current} />
            </div>
          )}
        </main>
        <aside
          className={`fixed top-0 bottom-0 h-full transition-transform duration-300 ease-in-out z-[60] w-full max-w-sm md:w-80 md:relative md:translate-x-0 ${
            isParticipantsOpen ? "translate-x-0" : "-translate-x-full"
          } left-0 flex flex-col bg-gray-900/80 backdrop-blur-md p-4 text-white shadow-xl`}
        >
          <div className="flex justify-between items-center mb-2 border-b border-gray-600 pb-2 flex-shrink-0">
            <h4 className="font-bold text-lg">Participants</h4>
            <button
              onClick={() => setParticipantsOpen(false)}
              className="md:hidden text-gray-400 hover:text-white"
            >
              <X size={24} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-4">
            {isStreamReady && (
              <ParticipantTile
                peerId="you"
                nick={`${nick} (You)`}
                stream={localStreamRef.current}
                refEl={localVideoRef}
                onStage={() => setStageId("you")}
                isLocal={true}
                isOwner={isOwnerRef.current}
              />
            )}
            {Object.entries(people).map(
              ([id, { stream, nick, permissions }]) => (
                <ParticipantTile
                  key={id}
                  peerId={id}
                  nick={nick}
                  stream={stream}
                  onStage={() => setStageId(id)}
                  isLocal={false}
                  isOwner={isOwnerRef.current}
                  permissions={permissions}
                  onToggleChat={handleToggleChatPermission}
                />
              )
            )}
          </div>
        </aside>
        <Chat
          roomId={roomId}
          nick={nick}
          isChatEnabled={myPermissions.canChat}
          isOpen={isChatOpen}
          onClose={() => setChatOpen(false)}
        />
      </div>
      <ControlBar
        onToggleMic={toggleMic}
        micOn={micOn}
        onToggleCam={toggleCam}
        camOn={camOn}
        onShare={share ? stopShare : startShare}
        onLeave={leaveRoom}
        isSharing={!!share}
        toggleCode={() => setIsCodeOpen((v) => !v)}
      />
    </div>
  );
}
