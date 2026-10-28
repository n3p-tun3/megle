// Verifies the ID token that "Sign in with Google" hands the browser. The
// token is a JWT signed by Google, so checking it needs only Google's public
// keys and Node's crypto, no SDK.
const crypto = require('crypto');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
// Tolerates a server clock that is slightly off from Google's.
const CLOCK_SKEW_S = 60;

// kid -> KeyObject. Google rotates keys every few days and says how long to
// cache them in Cache-Control.
let keys = new Map();
let keysExpireAt = 0;
let keysFetchedAt = 0;
let pendingFetch = null;
// Junk tokens with made-up kids must not turn into a stream of fetches.
const MIN_REFETCH_MS = 60 * 1000;

function clientId() {
  return (process.env.GOOGLE_CLIENT_ID || '').trim();
}

async function fetchKeys() {
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Google certs returned ${res.status}`);

  const { keys: jwks = [] } = await res.json();
  keys = new Map(jwks.map((jwk) => [jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })]));

  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  keysFetchedAt = Date.now();
  keysExpireAt = keysFetchedAt + (maxAge ? Number(maxAge[1]) : 3600) * 1000;
}

async function keyFor(kid) {
  // An unknown kid before expiry means Google rotated early, so refetch.
  const expired = Date.now() >= keysExpireAt;
  const rotated = !keys.has(kid) && Date.now() - keysFetchedAt >= MIN_REFETCH_MS;
  if (expired || rotated) {
    // Concurrent sign-ins share one fetch instead of each starting their own.
    pendingFetch ||= fetchKeys().finally(() => {
      pendingFetch = null;
    });
    await pendingFetch;
  }
  return keys.get(kid);
}

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString());
}

// Resolves to { sub, email, name } for a genuine, unexpired token issued to
// this app, and throws for anything else.
async function verifyIdToken(token) {
  const aud = clientId();
  if (!aud) throw new Error('GOOGLE_CLIENT_ID is unset');

  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');

  const header = decodePart(parts[0]);
  if (header.alg !== 'RS256') throw new Error(`Unexpected alg ${header.alg}`);

  const key = await keyFor(header.kid);
  if (!key) throw new Error('Unknown signing key');

  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], 'base64url')
  );
  if (!valid) throw new Error('Bad signature');

  const claims = decodePart(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.has(claims.iss)) throw new Error('Wrong issuer');
  if (claims.aud !== aud) throw new Error('Token is for a different app');
  if (!claims.exp || claims.exp + CLOCK_SKEW_S < now) throw new Error('Token expired');
  if (!claims.email || claims.email_verified !== true) throw new Error('Email not verified');

  return { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name || '' };
}

module.exports = { clientId, verifyIdToken };
