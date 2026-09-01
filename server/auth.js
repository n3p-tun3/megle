const crypto = require('crypto');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const LOGIN_TOKEN_TTL_MS = 1000 * 60 * 15; // 15 minutes
const SESSION_COOKIE = 'megle_session';

// Single-use magic-link tokens, kept in memory. Losing these on restart only
// means a pending link stops working; issued sessions are unaffected because
// they are HMAC-signed cookies rather than server-side records.
const loginTokens = new Map();

function sessionSecret() {
  return process.env.SESSION_SECRET || 'dev-insecure-secret';
}

function allowedDomains() {
  return (process.env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedEmail(email) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return false;

  const domains = allowedDomains();
  if (domains.length === 0) return true; // unset means "any domain" (dev only)

  const domain = email.split('@')[1].toLowerCase();
  // Accept the domain itself plus its subdomains, so "edu.et" covers
  // "student.edu.et" without needing every subdomain listed.
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
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

function createLoginToken(email) {
  for (const [token, entry] of loginTokens) {
    if (entry.exp < Date.now()) loginTokens.delete(token);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  loginTokens.set(token, { email, exp: Date.now() + LOGIN_TOKEN_TTL_MS });
  return token;
}

function consumeLoginToken(token) {
  const entry = loginTokens.get(token);
  if (!entry) return null;
  loginTokens.delete(token); // single use, even if expired
  if (entry.exp < Date.now()) return null;
  return entry.email;
}

async function deliverLoginLink(email, link) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;

  if (!apiKey || !from) {
    console.log(`\n[auth] No mail provider configured. Magic link for ${email}:\n${link}\n`);
    return { delivered: 'console' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: 'Your megle sign-in link',
      text: `Sign in to megle:\n\n${link}\n\nThis link expires in 15 minutes.`,
    }),
  });

  if (!res.ok) {
    throw new Error(`Mail provider returned ${res.status}: ${await res.text()}`);
  }
  return { delivered: 'email' };
}

function warnOnInsecureConfig() {
  if (!process.env.SESSION_SECRET) {
    console.warn('[auth] SESSION_SECRET is unset. Using an insecure default (dev only).');
  }
  if (allowedDomains().length === 0) {
    console.warn('[auth] ALLOWED_EMAIL_DOMAINS is unset. Any email domain can sign in.');
  }
}

module.exports = {
  SESSION_COOKIE,
  isAllowedEmail,
  allowedDomains,
  createSession,
  sessionFromRequest,
  createLoginToken,
  consumeLoginToken,
  deliverLoginLink,
  warnOnInsecureConfig,
};
