const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

// Pages that never require a session. Everything else behind the auth gate.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/login.js', '/style.css', '/theme.js', '/landing.js']);

// email -> timestamp of last magic link, to stop someone hammering the mail API.
const lastLinkSentAt = new Map();
const LINK_THROTTLE_MS = 1000 * 30;

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

async function handleAuthRequest(req, res) {
  let email;
  try {
    ({ email } = await readJsonBody(req));
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  email = String(email || '').trim().toLowerCase();

  if (!auth.isAllowedEmail(email)) {
    const domains = auth.allowedDomains();
    return sendJson(res, 400, {
      error: domains.length
        ? `Use your school email address (${domains.join(' or ')}).`
        : 'Enter a valid email address.',
    });
  }

  const last = lastLinkSentAt.get(email) || 0;
  if (Date.now() - last < LINK_THROTTLE_MS) {
    return sendJson(res, 429, { error: 'A link was just sent. Check your inbox.' });
  }
  lastLinkSentAt.set(email, Date.now());

  const token = auth.createLoginToken(email);
  const link = `${originFor(req)}/auth/verify?token=${encodeURIComponent(token)}`;

  try {
    const { delivered } = await auth.deliverLoginLink(email, link);
    return sendJson(res, 200, { ok: true, delivered });
  } catch (err) {
    console.error('[auth] Failed to deliver login link:', err.message);
    return sendJson(res, 502, { error: 'Could not send the email. Try again shortly.' });
  }
}

function signInAndRedirect(req, res, email) {
  const secure = (req.headers['x-forwarded-proto'] || '') === 'https';
  const cookie = [
    `${auth.SESSION_COOKIE}=${auth.createSession(email)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 30}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');

  res.writeHead(302, { 'Set-Cookie': cookie, Location: '/' });
  res.end();
}

function handleAuthVerify(req, res, url) {
  const email = auth.consumeLoginToken(url.searchParams.get('token') || '');
  if (!email) {
    res.writeHead(302, { Location: '/login?error=expired' });
    return res.end();
  }
  signInAndRedirect(req, res, email);
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
  signInAndRedirect(req, res, auth.testAccountEmail(url.searchParams.get('as')));
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

  if (pathname === '/auth/request' && req.method === 'POST') {
    return handleAuthRequest(req, res);
  }

  if (pathname === '/auth/verify') {
    return handleAuthVerify(req, res, url);
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
    return serveStatic(res, '/login.html');
  }

  // The landing page, reachable when signed in too (the rules live there).
  if (pathname === '/about') {
    return serveStatic(res, '/landing.html');
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
    return sendJson(res, 200, { email: session.email });
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
    waiting.push(ws);
    send(ws, { type: 'status', status: 'searching' });
    return;
  }

  const partner = waiting.splice(partnerIdx, 1)[0];
  partners.set(ws, partner);
  partners.set(partner, ws);

  // The partner who was already waiting initiates the WebRTC offer.
  send(partner, { type: 'matched', initiator: true });
  send(ws, { type: 'matched', initiator: false });
}

function unpair(ws, { requeueSelf }) {
  const partner = partners.get(ws);
  if (partner) {
    partners.delete(ws);
    partners.delete(partner);
    send(partner, { type: 'partner-left' });
    tryMatch(partner);
  }
  removeFromWaiting(ws);
  if (requeueSelf) tryMatch(ws);
}

wss.on('connection', (ws, req) => {
  const session = auth.sessionFromRequest(req);
  if (!session) {
    send(ws, { type: 'unauthorized' });
    return ws.close(4001, 'Not signed in');
  }
  ws.email = session.email;
  online.add(ws);
  broadcastOnline();

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
        unpair(ws, { requeueSelf: true });
        break;

      // Leave the queue or the current pair but stay connected, so the
      // presence count still includes people idling on the page.
      case 'leave':
        unpair(ws, { requeueSelf: false });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    unpair(ws, { requeueSelf: false });
    online.delete(ws);
    broadcastOnline();
  });
});

server.listen(PORT, () => {
  auth.warnOnInsecureConfig();
  console.log(`Signaling server listening on :${PORT}`);
});
