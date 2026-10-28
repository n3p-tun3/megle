const buttonEl = document.getElementById('google-btn');
const messageEl = document.getElementById('form-message');
const inAppTip = document.getElementById('in-app-tip');

// Google refuses to sign in from embedded webviews, which is where links
// opened from Telegram, Instagram or Facebook usually land. Saying so up
// front beats a cryptic "disallowed_useragent" error page.
const IN_APP_BROWSER = /FBAN|FBAV|Instagram|Telegram|Line\/|; wv\)/i;
inAppTip.hidden = !IN_APP_BROWSER.test(navigator.userAgent);

function setMessage(text, kind = 'error') {
  messageEl.textContent = text;
  messageEl.dataset.kind = kind;
}

const gsiLoaded = new Promise((resolve, reject) => {
  const script = document.getElementById('gsi-script');
  if (window.google?.accounts?.id) return resolve();
  script.addEventListener('load', resolve);
  script.addEventListener('error', reject);
});

async function onCredential({ credential }) {
  setMessage('Signing you in…', 'info');
  try {
    const res = await fetch('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    location.href = '/';
  } catch (err) {
    setMessage(err.message === 'Failed to fetch' ? 'Network error. Check your connection and try again.' : err.message);
  }
}

function renderButton() {
  buttonEl.replaceChildren();
  google.accounts.id.renderButton(buttonEl, {
    type: 'standard',
    theme: document.documentElement.dataset.theme === 'light' ? 'outline' : 'filled_black',
    size: 'large',
    shape: 'pill',
    text: 'continue_with',
    logo_alignment: 'center',
    // Google takes a fixed pixel width between 200 and 400.
    width: Math.max(200, Math.min(400, buttonEl.clientWidth)),
  });
}

(async () => {
  const config = await fetch('/auth/config')
    .then((res) => res.json())
    .catch(() => null);
  if (!config?.googleClientId) {
    buttonEl.hidden = true;
    setMessage("Google sign-in isn't set up on this server yet.");
    return;
  }

  try {
    await gsiLoaded;
  } catch {
    setMessage("Couldn't reach Google. Check your connection and reload.");
    return;
  }

  google.accounts.id.initialize({
    client_id: config.googleClientId,
    callback: onCredential,
    context: 'signin',
    ux_mode: 'popup',
    itp_support: true,
  });
  renderButton();

  // Google's button is an iframe with its own colors, so it is redrawn when
  // the theme flips rather than left mismatched.
  new MutationObserver(renderButton).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
})();
