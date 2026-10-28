const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const db = require('./db');
const google = require('./google');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

// Pages that never require a session. Everything else behind the auth gate.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/login.js', '/style.css', '/theme.js', '/landing.js', '/screen-static.js']);

// Matches the maxlength on the chat input; enforced here too since a client
// can send whatever it likes over the socket.
const MAX_CHAT_LENGTH = 500;

function turnIceServers() {
  const { TURN_URL, TURN_USERNAME, TURN_PASSWORD } = process.env;
  if (!TURN_URL || !TURN_USERNAME || !TURN_PASSWORD) return [];

  return [TURN_URL, `${TURN_URL}?transport=tcp`].map((urls) => ({
    urls,
    username: TURN_USERNAME,
    credential: TURN_PASSWORD,
  }));
}

function originFor(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// The browser gets an ID token from Google's button and posts it here. A
// verified Google email is the whole sign-in: no codes, no passwords.
async function handleGoogleSignIn(req, res) {
  // Requiring JSON forces a CORS preflight on cross-site posts, so another
  // site can't silently sign a visitor into an account of its choosing.
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    return sendJson(res, 415, { error: 'Expected JSON' });
  }

  let credential;
  try {
    ({ credential } = await readJsonBody(req));
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  let user;
  try {
    user = await google.verifyIdToken(credential);
  } catch (err) {
    console.warn('[auth] Rejected Google sign-in:', err.message);
    return sendJson(res, 401, { error: 'Google sign-in failed. Try again.' });
  }

  res.setHeader('Set-Cookie', sessionCookie(req, user.email));
  return sendJson(res, 200, { ok: true });
}

function sessionCookie(req, email) {
  const secure = (req.headers['x-forwarded-proto'] || '') === 'https';
  return [
    `${auth.SESSION_COOKIE}=${auth.createSession(email)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 30}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function handleTestLogin(req, res, url) {
  if (!auth.testLoginEnabled()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  if (!auth.checkTestLoginCode(url.searchParams.get('code'))) {
    res.writeHead(403);
    return res.end('Bad test login code');
  }
  res.writeHead(302, {
    'Set-Cookie': sessionCookie(req, auth.testAccountEmail(url.searchParams.get('as'))),
    Location: '/',
  });
  res.end();
}

function serveStatic(res, reqPath) {
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, originFor(req));
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (pathname === '/auth/google' && req.method === 'POST') {
    return handleGoogleSignIn(req, res);
  }

  // The login page needs the client ID to draw Google's button. It is public
  // by design: Google only accepts it from the origins registered for it.
  if (pathname === '/auth/config') {
    return sendJson(res, 200, { googleClientId: google.clientId() || null });
  }

  if (pathname === '/auth/test-login') {
    return handleTestLogin(req, res, url);
  }

  if (pathname === '/auth/logout') {
    const cookie = `${auth.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    res.writeHead(302, { 'Set-Cookie': cookie, Location: '/' });
    return res.end();
  }

  if (pathname === '/login') {
    // Already signed in: nothing to do here.
    if (auth.sessionFromRequest(req)) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return serveStatic(res, '/login.html');
  }

  // The landing page, also reachable when signed in.
  if (pathname === '/about') {
    return serveStatic(res, '/landing.html');
  }

  if (pathname === '/rules') {
    return serveStatic(res, '/rules.html');
  }

  // Public on purpose: the landing page shows it as social proof. It's a
  // single number, so it reveals nothing about who is on.
  if (pathname === '/api/online') {
    return sendJson(res, 200, { count: online.size });
  }

  if (PUBLIC_PATHS.has(pathname)) {
    return serveStatic(res, pathname);
  }

  // Everything below requires a valid session.
  const session = auth.sessionFromRequest(req);
  if (!session) {
    // Visitors who aren't signed in meet the landing page first.
    if (pathname === '/') return serveStatic(res, '/landing.html');
    if (pathname.endsWith('.html')) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    return sendJson(res, 401, { error: 'Not signed in' });
  }

  if (pathname === '/api/me') {
    return sendJson(res, 200, { email: session.email, admin: auth.isAdmin(session.email) });
  }

  // Admin board: pages and data. Anyone else gets a plain 404, so the board
  // isn't even confirmed to exist.
  if (pathname === '/admin' || pathname.startsWith('/admin') || pathname.startsWith('/api/admin/')) {
    if (!auth.isAdmin(session.email)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    if (pathname === '/admin') return serveStatic(res, '/admin.html');
    if (pathname === '/api/admin/live') return sendJson(res, 200, liveSnapshot());
    if (pathname === '/api/admin/stats') {
      const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 30));
      try {
        return sendJson(res, 200, { enabled: db.enabled(), stats: await db.stats(days) });
      } catch (err) {
        console.error('[admin] Stats query failed:', err.message);
        return sendJson(res, 500, { error: 'Stats query failed' });
      }
    }
  }

  // Gated so the TURN credentials are only reachable by signed-in students,
  // rather than by anyone who loads the page.
  if (pathname === '/turn-config.json') {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, ...turnIceServers()];
    return sendJson(res, 200, { iceServers });
  }

  serveStatic(res, pathname === '/' ? '/index.html' : pathname);
});

const wss = new WebSocketServer({ server });

// Clients waiting to be matched.
const waiting = [];
// ws -> partner ws, for clients currently paired.
const partners = new Map();
// Every authenticated socket, whether or not it is looking for a match.
// Clients hold this open from page load, so it doubles as the presence count.
const online = new Set();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastOnline() {
  const msg = { type: 'online', count: online.size };
  for (const client of online) send(client, msg);
}

function removeFromWaiting(ws) {
  const idx = waiting.indexOf(ws);
  if (idx !== -1) waiting.splice(idx, 1);
}

function tryMatch(ws) {
  removeFromWaiting(ws);

  const partnerIdx = waiting.findIndex((peer) => peer.readyState === peer.OPEN);
  if (partnerIdx === -1) {
    ws.waitingSince = Date.now();
    waiting.push(ws);
    send(ws, { type: 'status', status: 'searching' });
    return;
  }

  const partner = waiting.splice(partnerIdx, 1)[0];
  partners.set(ws, partner);
  partners.set(partner, ws);

  const now = Date.now();
  ws.pairedAt = partner.pairedAt = now;
  ws.connResult = partner.connResult = null;
  // Only the initiator's connection report is logged, so each call counts once.
  partner.isInitiator = true;
  ws.isInitiator = false;
  // Records that a call started and how long the waiting side waited, but
  // not who was in it.
  db.logEvent('match', null, { wait_ms: now - (partner.waitingSince || now) });

  // The partner who was already waiting initiates the WebRTC offer.
  send(partner, { type: 'matched', initiator: true });
  send(ws, { type: 'matched', initiator: false });
}

function unpair(ws, { requeueSelf, reason }) {
  const partner = partners.get(ws);
  if (partner) {
    partners.delete(ws);
    partners.delete(partner);
    db.logEvent('call_end', null, { duration_ms: Date.now() - ws.pairedAt, ended: reason });
    send(partner, { type: 'partner-left' });
    tryMatch(partner);
  }
  removeFromWaiting(ws);
  if (requeueSelf) tryMatch(ws);
}

function deviceKind(userAgent = '') {
  if (/iPad|Tablet/i.test(userAgent)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

const STARTED_AT = Date.now();

// Everything the admin board's live tab shows. Calls are counts only: the
// board says a call is happening, never who it's between.
function liveSnapshot() {
  const now = Date.now();
  const STATE_RANK = { idle: 0, searching: 1, 'in call': 2 };
  const people = new Map();

  for (const ws of online) {
    const state = partners.has(ws) ? 'in call' : waiting.includes(ws) ? 'searching' : 'idle';
    const prev = people.get(ws.email);
    // One row per person even with several tabs open: earliest connection,
    // busiest state.
    if (!prev) {
      people.set(ws.email, { email: ws.email, since: ws.connectedAt, state, device: ws.device, tabs: 1 });
    } else {
      prev.tabs += 1;
      prev.since = Math.min(prev.since, ws.connectedAt);
      if (STATE_RANK[state] > STATE_RANK[prev.state]) prev.state = state;
    }
  }

  const calls = { total: 0, direct: 0, relay: 0, connecting: 0 };
  for (const [ws, partner] of partners) {
    if (!ws.isInitiator) continue;
    calls.total += 1;
    const result = ws.connResult || partner.connResult;
    if (result === 'direct' || result === 'relay') calls[result] += 1;
    else calls.connecting += 1;
  }

  const waits = waiting.map((ws) => now - (ws.waitingSince || now));
  const memory = process.memoryUsage();

  return {
    at: now,
    sockets: online.size,
    people: people.size,
    waiting: waiting.length,
    longestWaitS: waits.length ? Math.round(Math.max(...waits) / 1000) : 0,
    calls,
    users: [...people.values()].sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || a.since - b.since),
    health: {
      uptimeS: Math.round((now - STARTED_AT) / 1000),
      rssMb: Math.round(memory.rss / 1048576),
      heapMb: Math.round(memory.heapUsed / 1048576),
      node: process.version,
      commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
      database: db.enabled(),
    },
  };
}

wss.on('connection', (ws, req) => {
  const session = auth.sessionFromRequest(req);
  if (!session) {
    send(ws, { type: 'unauthorized' });
    return ws.close(4001, 'Not signed in');
  }
  ws.email = session.email;
  ws.connectedAt = Date.now();
  ws.device = deviceKind(req.headers['user-agent']);
  online.add(ws);
  broadcastOnline();
  db.touchUser(ws.email);
  db.logEvent('connect', ws.email, { device: ws.device });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'find':
        tryMatch(ws);
        break;

      case 'signal': {
        const partner = partners.get(ws);
        if (partner) send(partner, { type: 'signal', data: msg.data });
        break;
      }

      case 'chat': {
        const partner = partners.get(ws);
        const text = String(msg.text ?? '').trim().slice(0, MAX_CHAT_LENGTH);
        if (partner && text) send(partner, { type: 'chat', text });
        break;
      }

      case 'typing': {
        const partner = partners.get(ws);
        if (partner) send(partner, { type: 'typing' });
        break;
      }

      case 'next':
        unpair(ws, { requeueSelf: true, reason: 'next' });
        break;

      // Leave the queue or the current pair but stay connected, so the
      // presence count still includes people idling on the page.
      case 'leave':
        unpair(ws, { requeueSelf: false, reason: 'leave' });
        break;

      // How this call's WebRTC connection came up, reported by the client:
      // directly, through the TURN relay, or not at all.
      case 'conn': {
        const result = ['direct', 'relay', 'failed'].includes(msg.result) ? msg.result : null;
        const partner = partners.get(ws);
        if (!result || !partner || ws.connResult) break;
        ws.connResult = result;
        if (!partner.connResult) partner.connResult = result;
        if (ws.isInitiator) db.logEvent('conn', null, { result });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    unpair(ws, { requeueSelf: false, reason: 'disconnect' });
    online.delete(ws);
    broadcastOnline();
  });
});

db.init();

server.listen(PORT, () => {
  auth.warnOnInsecureConfig();
  console.log(`Signaling server listening on :${PORT}`);
});
