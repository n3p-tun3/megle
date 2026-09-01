const form = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submit-btn');
const messageEl = document.getElementById('form-message');
const sentState = document.getElementById('sent-state');
const sentEmailEl = document.getElementById('sent-email');
const retryBtn = document.getElementById('retry-btn');

function setMessage(text, kind = 'error') {
  messageEl.textContent = text;
  messageEl.dataset.kind = kind;
}

if (new URLSearchParams(location.search).get('error') === 'expired') {
  setMessage('That sign-in link expired or was already used. Request a new one.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('');

  const email = emailInput.value.trim();
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';

  try {
    const res = await fetch('/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (!res.ok) {
      setMessage(data.error || 'Something went wrong. Try again.');
      return;
    }

    sentEmailEl.textContent = email;
    form.hidden = true;
    sentState.hidden = false;

    if (data.delivered === 'console') {
      setMessage('No mail provider configured: the link was printed to the server log.', 'info');
      sentState.prepend(messageEl);
    }
  } catch {
    setMessage('Network error. Check your connection and try again.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Email me a link';
  }
});

retryBtn.addEventListener('click', () => {
  sentState.hidden = true;
  form.hidden = false;
  setMessage('');
  emailInput.focus();
});
