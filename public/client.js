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

// Unconstrained `video: true` often yields 640x480 (4:3), which pillarboxes
// badly in the wide stage tiles. These are "ideal", not "exact", so a camera
// that cannot do 720p still works and just returns its closest match.
const MEDIA_CONSTRAINTS = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    aspectRatio: { ideal: 16 / 9 },
    facingMode: 'user',
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

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
const stageEl = document.querySelector('.stage');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const startBtn = document.getElementById('start-btn');
const nextBtn = document.getElementById('next-btn');
const stopBtn = document.getElementById('stop-btn');
const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const cameraOffLabel = document.querySelector('.camera-off-label');
const pipBtn = document.getElementById('pip-btn');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const typingIndicator = document.getElementById('typing-indicator');

let ws = null;
let pc = null;
let localStream = null;
let iceServers = FALLBACK_ICE_SERVERS;
let audioCtx = null;

// True once the user has pressed Start, so a reconnect knows to rejoin the
// queue rather than sitting idle.
let wantMatch = false;
let leavingPage = false;
let reconnectDelay = 1000;
let reconnectTimer = null;

let typingHideTimer = null;
let lastTypingSentAt = 0;
const TYPING_SEND_INTERVAL_MS = 1200;
const TYPING_HIDE_DELAY_MS = 3000;

// Picture-in-picture is only offered on browsers that actually support it.
const pipSupported =
  document.pictureInPictureEnabled && typeof remoteVideo.requestPictureInPicture === 'function';

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

function showTypingIndicator() {
  typingIndicator.hidden = false;
  clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(() => {
    typingIndicator.hidden = true;
  }, TYPING_HIDE_DELAY_MS);
}

function hideTypingIndicator() {
  clearTimeout(typingHideTimer);
  typingIndicator.hidden = true;
}

// Synthesized rather than an audio file: a two-note chime is a few lines of
// Web Audio API and keeps the app dependency-free. Volume is kept low and
// short since a call can be answered anywhere, including a quiet room.
function playMatchChime() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [660, 880].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const t0 = now + i * 0.09;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.07, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.2);
  });
}

stageEl.addEventListener('animationend', (event) => {
  if (event.animationName === 'match-flash') stageEl.classList.remove('flash');
});

function flashStage() {
  stageEl.classList.remove('flash');
  void stageEl.offsetWidth; // restart the animation if it's already mid-flash
  stageEl.classList.add('flash');
}

function resetMediaToggles() {
  micBtn.setAttribute('aria-pressed', 'false');
  micBtn.textContent = 'Mic';
  micBtn.title = 'Mute microphone';
  camBtn.setAttribute('aria-pressed', 'false');
  camBtn.textContent = 'Cam';
  camBtn.title = 'Turn camera off';
  cameraOffLabel.hidden = true;
}

function toggleMic() {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const muted = !track.enabled;
  micBtn.setAttribute('aria-pressed', String(muted));
  micBtn.textContent = muted ? 'Mic off' : 'Mic';
  micBtn.title = muted ? 'Unmute microphone' : 'Mute microphone';
}

function toggleCamera() {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const off = !track.enabled;
  camBtn.setAttribute('aria-pressed', String(off));
  camBtn.textContent = off ? 'Cam off' : 'Cam';
  camBtn.title = off ? 'Turn camera on' : 'Turn camera off';
  cameraOffLabel.hidden = !off;
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
      playMatchChime();
      flashStage();
      if (pipSupported) pipBtn.hidden = false;
      break;

    case 'signal':
      handleSignal(msg.data);
      break;

    case 'chat':
      hideTypingIndicator();
      addChatMessage(msg.text, 'stranger');
      break;

    case 'typing':
      showTypingIndicator();
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

  // Created here, inside a click handler, so the browser's autoplay policy
  // treats it as user-initiated and later programmatic playMatchChime()
  // calls (triggered by a server message, not a gesture) are allowed to play.
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) audioCtx = new AudioCtx();
  }
  if (audioCtx?.state === 'suspended') audioCtx.resume();

  iceServers = await getIceServers();

  try {
    localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
  } catch (err) {
    setStatus(`Camera or microphone access failed: ${err.message}`, 'error');
    startBtn.disabled = false;
    return;
  }
  localVideo.srcObject = localStream;
  localVideo.classList.add('active');
  resetMediaToggles();

  const settings = localStream.getVideoTracks()[0]?.getSettings();
  if (settings) {
    console.log(`Camera: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`);
  }

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
  hideTypingIndicator();
  pipBtn.hidden = true;
  if (document.pictureInPictureElement === remoteVideo) {
    document.exitPictureInPicture().catch(() => {});
  }
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
  resetMediaToggles();
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

chatInput.addEventListener('input', () => {
  if (chatInput.disabled) return;
  const now = Date.now();
  if (now - lastTypingSentAt < TYPING_SEND_INTERVAL_MS) return;
  lastTypingSentAt = now;
  sendToServer({ type: 'typing' });
});

startBtn.addEventListener('click', start);
nextBtn.addEventListener('click', next);
stopBtn.addEventListener('click', stop);
micBtn.addEventListener('click', toggleMic);
camBtn.addEventListener('click', toggleCamera);

if (pipSupported) {
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement === remoteVideo) {
        await document.exitPictureInPicture();
      } else {
        await remoteVideo.requestPictureInPicture();
      }
    } catch (err) {
      console.warn('Picture-in-picture failed', err);
    }
  });

  remoteVideo.addEventListener('enterpictureinpicture', () => {
    pipBtn.textContent = 'Return to tab';
  });
  remoteVideo.addEventListener('leavepictureinpicture', () => {
    pipBtn.textContent = 'Pop out';
  });

  // Best-effort: pop the remote feed out when the tab is backgrounded mid
  // call, so the conversation doesn't just freeze off-screen. Some browsers
  // reject a request that isn't tied to a user gesture, so failures here are
  // silent — the manual button above is the reliable fallback.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (remoteVideo.classList.contains('active') && !document.pictureInPictureElement) {
        remoteVideo.requestPictureInPicture().catch(() => {});
      }
    } else if (document.pictureInPictureElement === remoteVideo) {
      document.exitPictureInPicture().catch(() => {});
    }
  });
}

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
