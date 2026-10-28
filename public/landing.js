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

// A different pitch each visit. The HTML carries the first as the default,
// for anyone without JavaScript.
(() => {
  const HEADLINES = [
    ['Bored? Talk to someone.', 'Random video chats with other ASTU students.'],
    ['Someone on campus is bored too.', 'Press Start and find them. Random video chats, made for ASTU.'],
    ['Say hi to a stranger.', 'Random video chats around ASTU, one tap away.'],
    ['Skip scrolling. Talk to someone.', 'Random video chats with other ASTU students.'],
  ];
  const [title, body] = HEADLINES[Math.floor(Math.random() * HEADLINES.length)];
  document.getElementById('hero-title').textContent = title;
  document.getElementById('hero-body').textContent = body;
})();
