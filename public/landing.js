// TV static for the hero mockup, drawn once like the app's searching state.
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

// Signed-in visitors (who reach this page via /about) go straight to the app.
fetch('/api/me')
  .then((res) => (res.ok ? res.json() : null))
  .then((me) => {
    if (!me) return;
    for (const id of ['header-cta', 'hero-cta', 'footer-cta']) {
      const link = document.getElementById(id);
      link.href = '/';
      link.textContent = id === 'header-cta' ? 'Open app' : 'Open meetastu';
    }
  })
  .catch(() => {});
