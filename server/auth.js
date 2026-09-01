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

// Falling back to the campus domain rather than to "allow everything" means a
// missing env var on a deploy fails closed instead of opening the app up.
const DEFAULT_ALLOWED_DOMAINS = 'astust.edu.et';

function allowedDomains() {
  return (process.env.ALLOWED_EMAIL_DOMAINS || DEFAULT_ALLOWED_DOMAINS)
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedEmail(email) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return false;

  const domains = allowedDomains();
  if (domains.includes('*')) return true; // opt-in escape hatch for local dev

  const domain = email.split('@')[1].toLowerCase();
  // Accept the domain itself plus its subdomains, so "astust.edu.et" covers
  // "student.astust.edu.et" without listing every subdomain.
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

// Dashboards that expect a raw value often get pasted with surrounding
// quotes, which would make the From header invalid.
function unquote(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '').trim();
}

function mailFrom() {
  return unquote(process.env.MAIL_FROM);
}

async function deliverLoginLink(email, link) {
  const apiKey = unquote(process.env.RESEND_API_KEY);
  const from = mailFrom();

  if (!apiKey || !from) {
    console.log(`\n[auth] No mail provider configured. Magic link for ${email}:\n${link}\n`);
    return { delivered: 'console' };
  }

  const text = [
    'Sign in to megle:',
    '',
    link,
    '',
    'This link expires in 15 minutes and can only be used once.',
    'If you did not request it, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#18181b">
      <p>Click below to sign in to megle.</p>
      <p style="margin:24px 0">
        <a href="${link}"
           style="background:#2563eb;color:#fff;padding:11px 20px;border-radius:8px;
                  text-decoration:none;display:inline-block">Sign in to megle</a>
      </p>
      <p style="color:#52525b;font-size:13px">
        This link expires in 15 minutes and can only be used once.
        If you did not request it, you can ignore this email.
      </p>
    </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: email, subject: 'Your megle sign-in link', text, html }),
  });

  if (!res.ok) {
    throw new Error(`Mail provider returned ${res.status}: ${await res.text()}`);
  }

  // Log the provider's id so a "never arrived" report can be traced in the
  // Resend dashboard, where bounces and spam rejections show up.
  const body = await res.json().catch(() => ({}));
  console.log(`[auth] Sent login link to ${email} from "${from}" (resend id: ${body.id || 'unknown'})`);
  return { delivered: 'email' };
}

// A shared code that mints a session without email, so the app can be tried
// without a campus mailbox. Disabled unless TEST_LOGIN_CODE is set.
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
// profiles and match against themselves.
function testAccountEmail(seat) {
  const clean = String(seat || 'a').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'a';
  const domain = allowedDomains().find((d) => d !== '*') || DEFAULT_ALLOWED_DOMAINS;
  return `test-${clean}@${domain}`;
}

function warnOnInsecureConfig() {
  if (!process.env.SESSION_SECRET) {
    console.warn('[auth] SESSION_SECRET is unset. Using an insecure default (dev only).');
  }
  if (allowedDomains().includes('*')) {
    console.warn('[auth] ALLOWED_EMAIL_DOMAINS contains "*". Any email domain can sign in.');
  } else {
    console.log(`[auth] Sign-in restricted to: ${allowedDomains().join(', ')}`);
  }
  if (testLoginEnabled()) {
    console.warn('[auth] TEST_LOGIN_CODE is set. /auth/test-login can mint sessions.');
  }

  const from = mailFrom();
  if (process.env.RESEND_API_KEY && from) {
    console.log(`[auth] Mail delivery enabled, sending as "${from}".`);
  } else {
    console.warn(
      '[auth] Mail delivery disabled ' +
        `(RESEND_API_KEY ${process.env.RESEND_API_KEY ? 'set' : 'missing'}, ` +
        `MAIL_FROM ${from ? 'set' : 'missing'}). Links print to this log.`
    );
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
  testLoginEnabled,
  checkTestLoginCode,
  testAccountEmail,
  warnOnInsecureConfig,
};
