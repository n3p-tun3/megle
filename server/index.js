const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  let reqPath = req.url === '/' ? '/index.html' : req.url;
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
});

const wss = new WebSocketServer({ server });

// Clients waiting to be matched.
const waiting = [];
// ws -> partner ws, for clients currently paired.
const partners = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
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

wss.on('connection', (ws) => {
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

      case 'next':
        unpair(ws, { requeueSelf: true });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    unpair(ws, { requeueSelf: false });
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on :${PORT}`);
});
