// TV static for the hero screen, drawn once like the app's searching state.
(() => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = Math.random() * 255;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  document.documentElement.style.setProperty('--static', `url("${canvas.toDataURL()}")`);
})();

// Live count of students online, so the page doesn't feel empty. Hidden when
// nobody is on, since "0 online" is the opposite of an invitation.
fetch('/api/online')
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (!data || !data.count) return;
    document.getElementById('online-now-text').textContent =
      data.count === 1 ? '1 student online now' : `${data.count} students online now`;
    document.getElementById('online-now').hidden = false;
  })
  .catch(() => {});

// Signed-in visitors (who reach this page via /about) skip the sign-in step.
fetch('/api/me')
  .then((res) => {
    if (res.ok) document.getElementById('cta').href = '/';
  })
  .catch(() => {});

// TEMPORARY: headline candidates to compare. Delete once one is chosen.
(() => {
  const HEADLINES = [
    ['Bored? Talk to someone.', 'Random video chats with other ASTU students.'],
    ["Someone on campus is bored too.", 'Press Start and find them. Random video chats, ASTU students only.'],
    ['Say hi to a stranger.', "They're from ASTU. Random video chats, one tap away."],
    ['Your next conversation is on campus.', 'Random one-on-one video chats with ASTU students.'],
    ['Meet ASTU, one stranger at a time.', 'Random video chats. Press Next whenever you like.'],
    ['Skip scrolling. Talk to someone.', 'Random video chats with other ASTU students.'],
  ];
  const title = document.getElementById('hero-title');
  const body = document.getElementById('hero-body');
  const pick = document.createElement('select');
  HEADLINES.forEach(([h], i) => pick.add(new Option(`${i + 1}. ${h}`, i)));
  pick.style.cssText =
    'position:fixed;z-index:100;left:50%;bottom:12px;transform:translateX(-50%);max-width:92vw;' +
    'font:12px system-ui;padding:6px;border-radius:6px;background:var(--surface);color:var(--text);border:1px solid var(--border-strong)';
  pick.addEventListener('change', () => {
    [title.textContent, body.textContent] = HEADLINES[pick.value];
  });
  document.body.append(pick);
})();
