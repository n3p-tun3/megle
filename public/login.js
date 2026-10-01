const form = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const suffixEl = document.getElementById('email-suffix');
const submitBtn = document.getElementById('submit-btn');
const messageEl = document.getElementById('form-message');
const sentState = document.getElementById('sent-state');
const sentTitle = document.getElementById('sent-title');
const sentEmailEl = document.getElementById('sent-email');
const sentMessageEl = document.getElementById('sent-message');
const resendBtn = document.getElementById('resend-btn');
const retryBtn = document.getElementById('retry-btn');

const SCHOOL_DOMAIN = 'astust.edu.et';
// Matches the server's per-address throttle, so Resend is never offered
// while the server would refuse it.
const RESEND_COOLDOWN_S = 30;

let sentTo = '';
let cooldownTimer = null;

function setMessage(el, text, kind = 'error') {
  el.textContent = text;
  el.dataset.kind = kind;
}

// Students can type just the part before the @. Typing a full address
// (or autofill supplying one) hides the suffix and is used as-is.
function typedEmail() {
  const value = emailInput.value.trim().toLowerCase();
  if (!value) return '';
  return value.includes('@') ? value : `${value}@${SCHOOL_DOMAIN}`;
}

function syncSuffix() {
  suffixEl.hidden = emailInput.value.includes('@');
}

emailInput.addEventListener('input', () => {
  syncSuffix();
  setMessage(messageEl, '');
});
syncSuffix();
document.querySelector('.field-affix').addEventListener('click', () => emailInput.focus());

if (new URLSearchParams(location.search).get('error') === 'expired') {
  setMessage(messageEl, 'That sign-in link expired or was already used. Request a new one.');
}

async function requestLink(email) {
  const res = await fetch('/auth/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function startCooldown() {
  clearInterval(cooldownTimer);
  let left = RESEND_COOLDOWN_S;
  resendBtn.disabled = true;
  resendBtn.textContent = `Resend link in ${left}s`;
  cooldownTimer = setInterval(() => {
    left -= 1;
    if (left > 0) {
      resendBtn.textContent = `Resend link in ${left}s`;
      return;
    }
    clearInterval(cooldownTimer);
    resendBtn.disabled = false;
    resendBtn.textContent = 'Resend link';
  }, 1000);
}

function showSent(email, delivered) {
  sentTo = email;
  sentEmailEl.textContent = email;
  form.hidden = true;
  sentState.hidden = false;
  setMessage(
    sentMessageEl,
    delivered === 'console' ? 'No mail provider configured: the link was printed to the server log.' : '',
    'info'
  );
  startCooldown();
  // Move focus to the new content so screen readers announce it.
  sentTitle.focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage(messageEl, '');

  const email = typedEmail();
  if (!email) {
    setMessage(messageEl, 'Enter your school email.');
    emailInput.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';
  try {
    const data = await requestLink(email);
    showSent(email, data.delivered);
  } catch (err) {
    setMessage(messageEl, err.message === 'Failed to fetch' ? 'Network error. Check your connection and try again.' : err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Email me a link';
  }
});

resendBtn.addEventListener('click', async () => {
  resendBtn.disabled = true;
  resendBtn.textContent = 'Sending…';
  try {
    await requestLink(sentTo);
    setMessage(sentMessageEl, 'New link sent. Check your spam folder too.', 'info');
    startCooldown();
  } catch (err) {
    setMessage(sentMessageEl, err.message);
    resendBtn.disabled = false;
    resendBtn.textContent = 'Resend link';
  }
});

retryBtn.addEventListener('click', () => {
  clearInterval(cooldownTimer);
  sentState.hidden = true;
  form.hidden = false;
  setMessage(sentMessageEl, '');
  emailInput.focus();
});
