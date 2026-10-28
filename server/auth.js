const crypto = require('crypto');
const google = require('./google');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_COOKIE = 'megle_session';

function sessionSecret() {
  return process.env.SESSION_SECRET || 'dev-insecure-secret';
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

function createSession(email) {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(cookieValue) {
  if (!cookieValue) return null;

  const [payload, signature] = cookieValue.split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return null;
  if (!crypto.timingSafeEqual(expected, received)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function sessionFromRequest(req) {
  return readSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

// A shared code that mints a session without Google, so the app can be
// tried locally and matched against yourself. Disabled unless
// TEST_LOGIN_CODE is set.
function testLoginEnabled() {
  return Boolean(process.env.TEST_LOGIN_CODE);
}

function checkTestLoginCode(code) {
  const expected = process.env.TEST_LOGIN_CODE || '';
  if (!expected || !code) return false;

  const a = Buffer.from(String(code));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Distinct seats let one person sign in as two identities in two browser
// profiles and match against themselves. .test is reserved, so these can
// never collide with a real Google account.
function testAccountEmail(seat) {
  const clean = String(seat || 'a').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'a';
  return `test-${clean}@meetastu.test`;
}

// Who can open the admin board. Same sign-in as everyone else; the email
// just has to be on this list.
function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdmin(email) {
  return Boolean(email) && adminEmails().includes(String(email).toLowerCase());
}

function warnOnInsecureConfig() {
  if (!process.env.SESSION_SECRET) {
    console.warn('[auth] SESSION_SECRET is unset. Using an insecure default (dev only).');
  }
  if (google.clientId()) {
    console.log('[auth] Google sign-in enabled.');
  } else {
    console.warn('[auth] GOOGLE_CLIENT_ID is unset. Nobody can sign in except through the test login.');
  }
  if (adminEmails().length) {
    console.log(`[auth] Admin board open to: ${adminEmails().join(', ')}`);
  }
  if (testLoginEnabled()) {
    console.warn('[auth] TEST_LOGIN_CODE is set. /auth/test-login can mint sessions.');
  }
}

module.exports = {
  SESSION_COOKIE,
  createSession,
  sessionFromRequest,
  testLoginEnabled,
  checkTestLoginCode,
  testAccountEmail,
  isAdmin,
  warnOnInsecureConfig,
};
