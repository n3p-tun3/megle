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
//
// Always asked for in landscape terms, even on an upright phone: mobile
// browsers generally read width/height against the sensor's native landscape
// orientation and then rotate frames to match how the phone is held, so
// 1280x720 comes back as 720x1280 portrait. Swapping them here gets swapped
// back by the browser and yields a landscape strip. Not every browser agrees,
// so correctCameraOrientation() checks what actually arrived.
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

// An upright phone should send an upright picture. If this browser read the
// request the other way and delivered landscape frames anyway, ask again with
// the dimensions swapped; ideal constraints mean a camera that can't comply
// just keeps what it has.
async function correctCameraOrientation(track) {
  if (!matchMedia('(orientation: portrait) and (pointer: coarse)').matches) return;
  const { width, height } = track.getSettings();
  if (!width || !height || height >= width) return;
  try {
    await track.applyConstraints({ width: { ideal: 720 }, height: { ideal: 1280 } });
  } catch {
    // Keep the landscape stream; the layout still shows it whole.
  }
  const after = track.getSettings();
  console.log(`Camera orientation corrected: ${width}x${height} -> ${after.width}x${after.height}`);
}

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
const onlineEl = document.getElementById('online-count-text');
const sessionEmailEl = document.getElementById('session-email');
const accountInitialEl = document.getElementById('account-initial');
const accountBtn = document.getElementById('account-btn');
const accountMenu = document.getElementById('account-menu');
const headerRight = document.querySelector('.header-right');
const stageErrorEl = document.getElementById('stage-error');
const stageEl = document.querySelector('.stage');
const localTile = document.getElementById('local-tile');
const controlsEl = document.querySelector('.controls');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const startBtn = document.getElementById('start-btn');
const nextBtn = document.getElementById('next-btn');
const stopBtn = document.getElementById('stop-btn');
// Mic/camera toggles: not shipping yet, revisiting alongside the admin
// board. Markup is commented out in index.html to match — see the mirrored
// comment blocks below for the rest of this feature.
// const micBtn = document.getElementById('mic-btn');
// const camBtn = document.getElementById('cam-btn');
// const cameraOffLabel = document.querySelector('.camera-off-label');
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
  // The header no longer shows status, so errors are spelled out on the
  // stage where the user is already looking.
  if (state === 'error') stageErrorEl.textContent = text;
  // Drives what the empty stranger tile shows: a prompt, or static.
  stageEl.dataset.state = state;
}

// One tile of TV static, drawn once. CSS tiles it and jumps it between
// offsets, so no noise is generated per frame.
function makeStaticTile(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = Math.random() * 255;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

stageEl.style.setProperty('--static', `url("${makeStaticTile()}")`);

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

// ---------- video fit ----------

// Fill a video's box (cover) only when the feed's shape is close enough that
// filling it crops almost nothing; otherwise show the whole frame (contain).
// A portrait phone feed fills a portrait phone screen, while a landscape
// laptop feed is shown whole and letterboxed, the way FaceTime handles it.
const MAX_FILL_CROP = 0.2;

function fitVideo(video) {
  const { videoWidth: vw, videoHeight: vh } = video;
  const box = video.getBoundingClientRect();
  if (!vw || !vh || !box.width || !box.height) return;
  const feed = vw / vh;
  const frame = box.width / box.height;
  const crop = 1 - Math.min(feed, frame) / Math.max(feed, frame);
  video.style.objectFit = crop <= MAX_FILL_CROP ? 'cover' : 'contain';
}

// The mobile self-view card takes your camera's shape, so it's never cropped.
function syncLocalAspect() {
  const { videoWidth: vw, videoHeight: vh } = localVideo;
  if (!vw || !vh) return;
  localTile.style.setProperty('--pip-ar', `${vw} / ${vh}`);
  // Numeric form for sizing: the card keeps a constant long side, so a
  // landscape camera gives a wide card rather than a thin sliver.
  localTile.style.setProperty('--pip-ratio', String(vw / vh));
}

for (const video of [localVideo, remoteVideo]) {
  // `resize` fires when the incoming frame size changes mid-call, e.g. the
  // stranger rotating their phone.
  for (const type of ['loadedmetadata', 'resize']) {
    video.addEventListener(type, () => {
      if (video === localVideo) {
        syncLocalAspect();
        // The card just changed height; re-seat it now rather than waiting
        // on the next ResizeObserver tick.
        syncPipLayout();
      }
      fitVideo(video);
    });
  }
}

// ---------- self-view card (mobile) ----------

// Must match the mobile layout query in style.css.
const mobileLayout = matchMedia(
  '(max-width: 899.98px) and (orientation: portrait), (max-width: 899.98px) and (min-height: 561px)'
);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const PIP_MARGIN = 12;
// Apple's values for repositioning a PiP: critically damped (ratio 1.0, so no
// overshoot) with a 0.4s response. With unit mass, k = (2π / response)² and
// c = 2√k.
const PIP_STIFFNESS = ((2 * Math.PI) / 0.4) ** 2;
const PIP_DAMPING = 2 * Math.sqrt(PIP_STIFFNESS);
// Scroll-like deceleration, used to project where a flick would come to rest.
const PIP_DECELERATION = 0.998;
const PIP_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

const pip = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  corner: 'top-right',
  target: { x: 0, y: 0 },
  raf: 0,
  lastFrame: 0,
  pointerId: null,
  grabX: 0,
  grabY: 0,
  startX: 0,
  startY: 0,
  startTime: 0,
  history: [],
};

function pipBounds() {
  const stage = stageEl.getBoundingClientRect();
  const w = localTile.offsetWidth;
  const h = localTile.offsetHeight;
  // Bottom corners sit above the overlaid controls and input, not under them.
  const chromeTop = controlsEl.getBoundingClientRect().top - stage.top;
  // In a call the header's chips float top-left, so that corner starts
  // below them. The right side keeps the full height.
  const chipsBottom = document.body.dataset.call
    ? headerRight.getBoundingClientRect().bottom - stage.top + 8
    : PIP_MARGIN;
  return {
    minX: PIP_MARGIN,
    maxX: Math.max(PIP_MARGIN, stage.width - w - PIP_MARGIN),
    minY: PIP_MARGIN,
    minYLeft: Math.max(PIP_MARGIN, chipsBottom),
    maxY: Math.max(PIP_MARGIN, chromeTop - h - PIP_MARGIN),
  };
}

function cornerPoint(corner, bounds = pipBounds()) {
  return {
    x: corner.endsWith('left') ? bounds.minX : bounds.maxX,
    y: corner.startsWith('top')
      ? corner.endsWith('left') ? bounds.minYLeft : bounds.minY
      : bounds.maxY,
  };
}

function renderPip() {
  localTile.style.transform = `translate3d(${pip.x}px, ${pip.y}px, 0)`;
}

function stopPipSpring() {
  cancelAnimationFrame(pip.raf);
  pip.raf = 0;
}

function placePip(corner) {
  stopPipSpring();
  pip.corner = corner;
  const point = cornerPoint(corner);
  pip.x = point.x;
  pip.y = point.y;
  pip.vx = 0;
  pip.vy = 0;
  renderPip();
}

// Independent X and Y springs, so a diagonal flick can't desync the axes.
function stepPip(now) {
  let dt = Math.min((now - pip.lastFrame) / 1000, 1 / 30);
  pip.lastFrame = now;
  // Sub-step, so a dropped frame can't destabilise the integration.
  while (dt > 0) {
    const h = Math.min(dt, 1 / 240);
    const ax = -PIP_STIFFNESS * (pip.x - pip.target.x) - PIP_DAMPING * pip.vx;
    const ay = -PIP_STIFFNESS * (pip.y - pip.target.y) - PIP_DAMPING * pip.vy;
    pip.vx += ax * h;
    pip.vy += ay * h;
    pip.x += pip.vx * h;
    pip.y += pip.vy * h;
    dt -= h;
  }

  const settled =
    Math.abs(pip.x - pip.target.x) < 0.5 &&
    Math.abs(pip.y - pip.target.y) < 0.5 &&
    Math.hypot(pip.vx, pip.vy) < 20;
  if (settled) {
    placePip(pip.corner);
    return;
  }
  renderPip();
  pip.raf = requestAnimationFrame(stepPip);
}

// Spring to a corner from the card's live position, keeping whatever velocity
// it already has, whether that came from the finger or a flight in progress.
function springPipTo(corner) {
  pip.corner = corner;
  pip.target = cornerPoint(corner);
  if (reducedMotion.matches) {
    placePip(corner);
    return;
  }
  if (!pip.raf) {
    pip.lastFrame = performance.now();
    pip.raf = requestAnimationFrame(stepPip);
  }
}

// Where a flick at this velocity (px/s) would come to rest.
function project(velocity) {
  return ((velocity / 1000) * PIP_DECELERATION) / (1 - PIP_DECELERATION);
}

function nearestCorner(x, y) {
  const bounds = pipBounds();
  let best = pip.corner;
  let bestDistance = Infinity;
  for (const corner of PIP_CORNERS) {
    const point = cornerPoint(corner, bounds);
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = corner;
    }
  }
  return best;
}

// Past an edge the card still follows the finger, with growing resistance.
function rubberband(value, min, max, dimension) {
  const band = (overshoot) => (overshoot * dimension * 0.55) / (dimension + 0.55 * overshoot);
  if (value < min) return min - band(min - value);
  if (value > max) return max + band(value - max);
  return value;
}

localTile.addEventListener('pointerdown', (event) => {
  if (!mobileLayout.matches || pip.pointerId !== null) return;
  // Catch it mid-flight: pip.x/y are the live on-screen position, so stopping
  // the spring here causes no jump.
  stopPipSpring();
  pip.pointerId = event.pointerId;
  localTile.setPointerCapture(event.pointerId);
  const stage = stageEl.getBoundingClientRect();
  // Keep the offset from where it was grabbed instead of centring on the finger.
  pip.grabX = event.clientX - stage.left - pip.x;
  pip.grabY = event.clientY - stage.top - pip.y;
  pip.startX = event.clientX;
  pip.startY = event.clientY;
  pip.startTime = event.timeStamp;
  pip.history = [{ t: event.timeStamp, x: pip.x, y: pip.y }];
  localTile.classList.add('dragging');
});

localTile.addEventListener('pointermove', (event) => {
  if (event.pointerId !== pip.pointerId) return;
  const stage = stageEl.getBoundingClientRect();
  const bounds = pipBounds();
  pip.x = rubberband(event.clientX - stage.left - pip.grabX, bounds.minX, bounds.maxX, stage.width);
  pip.y = rubberband(event.clientY - stage.top - pip.grabY, bounds.minY, bounds.maxY, stage.height);
  renderPip();
  pip.history.push({ t: event.timeStamp, x: pip.x, y: pip.y });
  // Only the last ~100ms matter for the release velocity.
  while (pip.history.length > 2 && event.timeStamp - pip.history[0].t > 100) {
    pip.history.shift();
  }
});

function releasePip(event) {
  if (event.pointerId !== pip.pointerId) return;
  pip.pointerId = null;
  localTile.classList.remove('dragging');

  // A tap sends the card to the other side, so it can be moved without
  // dragging at all.
  const moved = Math.hypot(event.clientX - pip.startX, event.clientY - pip.startY);
  if (event.type === 'pointerup' && moved < 8 && event.timeStamp - pip.startTime < 300) {
    pip.vx = 0;
    pip.vy = 0;
    const [vertical, horizontal] = pip.corner.split('-');
    springPipTo(`${vertical}-${horizontal === 'left' ? 'right' : 'left'}`);
    return;
  }

  const first = pip.history[0];
  const last = pip.history[pip.history.length - 1];
  const span = (last.t - first.t) / 1000;
  // A finger that stopped before lifting shouldn't fling the card.
  const moving = span > 0 && event.timeStamp - last.t < 60;
  pip.vx = moving ? (last.x - first.x) / span : 0;
  pip.vy = moving ? (last.y - first.y) / span : 0;

  // Land where the gesture was heading, not where it was let go, and hand
  // the finger's velocity to the spring so there's no seam at release.
  springPipTo(nearestCorner(pip.x + project(pip.vx), pip.y + project(pip.vy)));
}

localTile.addEventListener('pointerup', releasePip);
localTile.addEventListener('pointercancel', releasePip);

function syncPipLayout() {
  if (!mobileLayout.matches) {
    stopPipSpring();
    localTile.style.transform = '';
    return;
  }
  if (pip.pointerId === null) placePip(pip.corner);
}

// The stage resizes on rotation and when the keyboard opens; the card resizes
// once the camera's aspect ratio is known. Either way, re-seat the card in
// its corner and re-decide how each feed should fit.
const layoutObserver = new ResizeObserver(() => {
  fitVideo(localVideo);
  fitVideo(remoteVideo);
  syncPipLayout();
});
layoutObserver.observe(stageEl);
layoutObserver.observe(localTile);
mobileLayout.addEventListener('change', syncPipLayout);
syncPipLayout();

// Mic/camera toggles: not shipping yet, revisiting alongside the admin
// board. Kept commented rather than deleted since it's fully working code —
// see the matching commented block in index.html for the button markup.
/*
// Phosphor Icons (MIT), vendored inline since this project has no build step
// to pull them from npm at build time. Only the "off" states need storing
// here — the "on" states are the icons already inlined in index.html.
const ICON_MICROPHONE = micBtn.innerHTML;
const ICON_MICROPHONE_SLASH =
  '<svg class="icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M213.92,218.62l-160-176A8,8,0,0,0,42.08,53.38L80,95.09V128a48,48,0,0,0,69.11,43.12l11.1,12.2A63.41,63.41,0,0,1,128,192a64.07,64.07,0,0,1-64-64,8,8,0,0,0-16,0,80.11,80.11,0,0,0,72,79.6V240a8,8,0,0,0,16,0V207.59a78.83,78.83,0,0,0,35.16-12.22l30.92,34a8,8,0,1,0,11.84-10.76ZM128,160a32,32,0,0,1-32-32V112.69l41.66,45.82A32,32,0,0,1,128,160Zm57.52-3.91A63.32,63.32,0,0,0,192,128a8,8,0,0,1,16,0,79.16,79.16,0,0,1-8.11,35.12,8,8,0,0,1-7.19,4.49,7.88,7.88,0,0,1-3.51-.82A8,8,0,0,1,185.52,156.09ZM84,44.87A48,48,0,0,1,176,64v64a49.19,49.19,0,0,1-.26,5,8,8,0,0,1-8,7.17,8.13,8.13,0,0,1-.84,0,8,8,0,0,1-7.12-8.79c.11-1.1.17-2.24.17-3.36V64A32,32,0,0,0,98.64,51.25,8,8,0,1,1,84,44.87Z"/></svg>';
const ICON_VIDEO_CAMERA = camBtn.innerHTML;
const ICON_VIDEO_CAMERA_SLASH =
  '<svg class="icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M251.77,73a8,8,0,0,0-8.21.39L208,97.05V72a16,16,0,0,0-16-16H113.06a8,8,0,0,0,0,16H192v87.63a8,8,0,0,0,16,0V159l35.56,23.71A8,8,0,0,0,248,184a8,8,0,0,0,8-8V80A8,8,0,0,0,251.77,73ZM240,161.05l-32-21.33V116.28L240,95ZM53.92,34.62A8,8,0,1,0,42.08,45.38L51.73,56H32A16,16,0,0,0,16,72V184a16,16,0,0,0,16,16H182.64l19.44,21.38a8,8,0,1,0,11.84-10.76ZM32,184V72H66.28L168.1,184Z"/></svg>';

function resetMediaToggles() {
  micBtn.setAttribute('aria-pressed', 'false');
  micBtn.innerHTML = ICON_MICROPHONE;
  micBtn.setAttribute('aria-label', 'Mute microphone');
  micBtn.title = 'Mute microphone';
  camBtn.setAttribute('aria-pressed', 'false');
  camBtn.innerHTML = ICON_VIDEO_CAMERA;
  camBtn.setAttribute('aria-label', 'Turn camera off');
  camBtn.title = 'Turn camera off';
  cameraOffLabel.hidden = true;
}

function toggleMic() {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const muted = !track.enabled;
  micBtn.setAttribute('aria-pressed', String(muted));
  micBtn.innerHTML = muted ? ICON_MICROPHONE_SLASH : ICON_MICROPHONE;
  const label = muted ? 'Unmute microphone' : 'Mute microphone';
  micBtn.setAttribute('aria-label', label);
  micBtn.title = label;
}

function toggleCamera() {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const off = !track.enabled;
  camBtn.setAttribute('aria-pressed', String(off));
  camBtn.innerHTML = off ? ICON_VIDEO_CAMERA_SLASH : ICON_VIDEO_CAMERA;
  const label = off ? 'Turn camera on' : 'Turn camera off';
  camBtn.setAttribute('aria-label', label);
  camBtn.title = label;
  cameraOffLabel.hidden = !off;
}
*/

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
  // Before the preview or any stranger sees it, so the first frame is already
  // the right way up.
  const cameraTrack = localStream.getVideoTracks()[0];
  if (cameraTrack) await correctCameraOrientation(cameraTrack);
  localVideo.srcObject = localStream;
  localVideo.classList.add('active');
  // resetMediaToggles(); // mic/camera toggles not shipped yet
  // On phones this tucks the header away for the length of the call.
  document.body.dataset.call = 'on';
  syncPipLayout();

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

// Named endCall rather than stop: a bare top-level `function stop` becomes
// `window.stop`, permanently shadowing the native Window.stop() API (verified
// via `stop.toString()` returning this function body). Anything that ever
// calls window.stop() expecting "cancel page load" — a browser extension,
// other embedded script, or automation tooling — would silently end the
// user's call instead.
function endCall() {
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
  // resetMediaToggles(); // mic/camera toggles not shipped yet
  delete document.body.dataset.call;
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
stopBtn.addEventListener('click', endCall);
// micBtn.addEventListener('click', toggleMic); // mic/camera toggles not shipped yet
// camBtn.addEventListener('click', toggleCamera);

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

  const setPipLabel = (text) => {
    pipBtn.setAttribute('aria-label', text);
    pipBtn.title = text;
  };
  remoteVideo.addEventListener('enterpictureinpicture', () => setPipLabel('Return to tab'));
  remoteVideo.addEventListener('leavepictureinpicture', () => setPipLabel('Pop out into a floating window'));

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
    if (!me) return;
    sessionEmailEl.textContent = me.email;
    accountInitialEl.textContent = me.email.charAt(0);
  })
  .catch(() => {});

// ---------- account menu ----------

const themeChoices = [...accountMenu.querySelectorAll('[data-theme-choice]')];

function menuItems() {
  return [...accountMenu.querySelectorAll('[role^="menuitem"]')];
}

function syncThemeChoices() {
  const current = window.meetastuTheme?.get() ?? 'system';
  themeChoices.forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.themeChoice === current));
  });
}

function openMenu(focusFirst) {
  syncThemeChoices();
  accountMenu.hidden = false;
  accountBtn.setAttribute('aria-expanded', 'true');
  if (focusFirst) menuItems()[0]?.focus();
}

function closeMenu(returnFocus) {
  if (accountMenu.hidden) return;
  accountMenu.hidden = true;
  accountBtn.setAttribute('aria-expanded', 'false');
  if (returnFocus) accountBtn.focus();
}

accountBtn.addEventListener('click', (event) => {
  // detail is 0 for keyboard activation: move focus in only then, so a
  // mouse click doesn't paint a focus ring on the first item.
  if (accountMenu.hidden) openMenu(event.detail === 0);
  else closeMenu(false);
});

accountBtn.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    openMenu(true);
  }
});

themeChoices.forEach((btn) => {
  btn.addEventListener('click', () => {
    window.meetastuTheme?.set(btn.dataset.themeChoice);
    syncThemeChoices();
  });
});

accountMenu.addEventListener('keydown', (event) => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu(true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
    event.preventDefault();
    items[(i + 1) % items.length].focus();
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    event.preventDefault();
    items[(i - 1 + items.length) % items.length].focus();
  } else if (event.key === 'Tab') {
    closeMenu(false);
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!accountMenu.hidden && !event.target.closest('.account')) closeMenu(false);
});

connect();
