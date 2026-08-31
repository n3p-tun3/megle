const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Open Relay Project: free, public, shared TURN server — fine for
  // prototyping, but rate-limited/shared with everyone else using it.
  // Swap in your own free-tier TURN (e.g. Metered.ca) before sharing
  // this with more than a couple of friends. See README.
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const statusEl = document.getElementById('status');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const startBtn = document.getElementById('start-btn');
const nextBtn = document.getElementById('next-btn');
const stopBtn = document.getElementById('stop-btn');

let ws = null;
let pc = null;
let localStream = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

async function start() {
  startBtn.disabled = true;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    setStatus(`camera/mic access failed: ${err.message}`);
    startBtn.disabled = false;
    return;
  }
  localVideo.srcObject = localStream;

  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'find' }));
  });

  ws.addEventListener('message', (event) => handleMessage(JSON.parse(event.data)));

  ws.addEventListener('close', () => {
    setStatus('disconnected');
    teardownPeer();
  });

  nextBtn.disabled = false;
  stopBtn.disabled = false;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'status':
      setStatus(msg.status);
      break;

    case 'matched':
      setStatus('connected — say hi');
      setupPeer(msg.initiator);
      break;

    case 'signal':
      handleSignal(msg.data);
      break;

    case 'partner-left':
      setStatus('stranger disconnected — searching for a new one');
      teardownPeer();
      break;

    default:
      break;
  }
}

function setupPeer(initiator) {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', data }));
  }
}

function teardownPeer() {
  if (pc) {
    pc.close();
    pc = null;
  }
  remoteVideo.srcObject = null;
}

function next() {
  teardownPeer();
  setStatus('searching');
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'next' }));
  }
}

function stop() {
  teardownPeer();
  if (ws) {
    ws.close();
    ws = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  setStatus('idle');
  startBtn.disabled = false;
  nextBtn.disabled = true;
  stopBtn.disabled = true;
}

startBtn.addEventListener('click', start);
nextBtn.addEventListener('click', next);
stopBtn.addEventListener('click', stop);
