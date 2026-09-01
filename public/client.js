const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Public shared TURN, used only if the server has no dedicated TURN
  // credentials configured (e.g. running locally without a .env).
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

async function getIceServers() {
  try {
    const res = await fetch('/turn-config.json');
    if (res.ok) {
      const { iceServers } = await res.json();
      const hasTurn = (iceServers || []).some((s) => JSON.stringify(s.urls).includes('turn:'));
      if (hasTurn) return iceServers;
    }
  } catch {
    // fall through to the hardcoded fallback below
  }
  return FALLBACK_ICE_SERVERS;
}

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const onlineEl = document.getElementById('online-count');
const sessionEmailEl = document.getElementById('session-email');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const startBtn = document.getElementById('start-btn');
const nextBtn = document.getElementById('next-btn');
const stopBtn = document.getElementById('stop-btn');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');

let ws = null;
let pc = null;
let localStream = null;
let iceServers = FALLBACK_ICE_SERVERS;

// True once the user has pressed Start, so a reconnect knows to rejoin the
// queue rather than sitting idle.
let wantMatch = false;
let leavingPage = false;
let reconnectDelay = 1000;
let reconnectTimer = null;

function setStatus(text, state = 'idle') {
  statusTextEl.textContent = text;
  statusEl.dataset.state = state;
}

function setOnlineCount(count) {
  onlineEl.textContent = count === 1 ? '1 online' : `${count} online`;
}

function addChatMessage(text, from) {
  const wasAtBottom =
    chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;

  const line = document.createElement('p');
  line.className = 'chat-msg';
  line.dataset.from = from;

  if (from !== 'system') {
    const author = document.createElement('span');
    author.className = 'chat-msg-author';
    author.textContent = from === 'you' ? 'You' : 'Stranger';
    line.append(author);
  }

  // textContent, never innerHTML: message bodies come from another user.
  line.append(document.createTextNode(text));
  chatLog.append(line);

  if (wasAtBottom) chatLog.scrollTop = chatLog.scrollHeight;
}

function clearChat() {
  chatLog.replaceChildren();
}

function setChatEnabled(enabled) {
  chatInput.disabled = !enabled;
  chatSend.disabled = !enabled;
  chatInput.placeholder = enabled ? 'Say something' : 'Start a chat to send messages';
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

// The socket is opened on page load and held for the whole visit: it carries
// the presence count, not just matchmaking.
function connect() {
  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    // Clear any "Reconnecting..." left over from the drop that got us here.
    if (wantMatch) {
      setStatus('Searching for a stranger...', 'searching');
      sendToServer({ type: 'find' });
    } else {
      setStatus('Idle', 'idle');
    }
  });

  ws.addEventListener('message', (event) => handleMessage(JSON.parse(event.data)));

  ws.addEventListener('close', () => {
    if (leavingPage) return;

    teardownPeer();
    setChatEnabled(false);
    setOnlineCount(0);
    setStatus('Reconnecting...', 'error');

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'unauthorized':
      leavingPage = true;
      setStatus('Session expired. Redirecting to sign in...', 'error');
      location.href = '/login';
      break;

    case 'online':
      setOnlineCount(msg.count);
      break;

    case 'status':
      setStatus('Searching for a stranger...', 'searching');
      break;

    case 'matched':
      setStatus('Connected. Say hi.', 'connected');
      clearChat();
      addChatMessage('You are now chatting with a stranger.', 'system');
      setChatEnabled(true);
      setupPeer(msg.initiator);
      break;

    case 'signal':
      handleSignal(msg.data);
      break;

    case 'chat':
      addChatMessage(msg.text, 'stranger');
      break;

    case 'partner-left':
      setStatus('Stranger left. Searching for someone new...', 'searching');
      addChatMessage('Stranger has disconnected.', 'system');
      setChatEnabled(false);
      teardownPeer();
      break;

    default:
      break;
  }
}

async function start() {
  startBtn.disabled = true;

  iceServers = await getIceServers();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    setStatus(`Camera or microphone access failed: ${err.message}`, 'error');
    startBtn.disabled = false;
    return;
  }
  localVideo.srcObject = localStream;
  localVideo.classList.add('active');

  wantMatch = true;
  nextBtn.disabled = false;
  stopBtn.disabled = false;

  if (!sendToServer({ type: 'find' })) {
    setStatus('Reconnecting...', 'error');
  }
}

function setupPeer(initiator) {
  pc = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    remoteVideo.classList.add('active');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ candidate: event.candidate });
    }
  };

  if (initiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ description: pc.localDescription });
    };
  }
}

async function handleSignal(data) {
  if (!pc) return;

  if (data.description) {
    await pc.setRemoteDescription(data.description);
    if (data.description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ description: pc.localDescription });
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      console.warn('Failed to add ICE candidate', err);
    }
  }
}

function sendSignal(data) {
  sendToServer({ type: 'signal', data });
}

function teardownPeer() {
  if (pc) {
    pc.close();
    pc = null;
  }
  remoteVideo.classList.remove('active');
  remoteVideo.srcObject = null;
}

function next() {
  teardownPeer();
  setChatEnabled(false);
  clearChat();
  setStatus('Searching for a stranger...', 'searching');
  sendToServer({ type: 'next' });
}

function stop() {
  wantMatch = false;
  teardownPeer();

  // Leave the queue but keep the socket open, so this tab still counts
  // toward the presence total while idle.
  sendToServer({ type: 'leave' });

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.classList.remove('active');
  localVideo.srcObject = null;
  setChatEnabled(false);
  clearChat();
  setStatus('Idle', 'idle');
  startBtn.disabled = false;
  nextBtn.disabled = true;
  stopBtn.disabled = true;
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const text = chatInput.value.trim();
  if (!text) return;
  if (!sendToServer({ type: 'chat', text })) return;

  addChatMessage(text, 'you');
  chatInput.value = '';
});

startBtn.addEventListener('click', start);
nextBtn.addEventListener('click', next);
stopBtn.addEventListener('click', stop);

window.addEventListener('pagehide', () => {
  leavingPage = true;
});

fetch('/api/me')
  .then((res) => (res.ok ? res.json() : null))
  .then((me) => {
    if (me) sessionEmailEl.textContent = me.email;
  })
  .catch(() => {});

connect();
