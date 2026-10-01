// Applies the saved theme before first paint (loaded synchronously in <head>),
// so a light-mode user never sees a dark flash. "system" follows the OS and
// keeps following it if it changes while the page is open.
(() => {
  const KEY = 'meetastu-theme';
  const systemLight = matchMedia('(prefers-color-scheme: light)');
  let pref = 'system';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') pref = saved;
  } catch {}

  function apply() {
    document.documentElement.dataset.theme =
      pref === 'system' ? (systemLight.matches ? 'light' : 'dark') : pref;
  }

  systemLight.addEventListener('change', apply);
  apply();

  window.meetastuTheme = {
    get: () => pref,
    set(value) {
      pref = value;
      try {
        if (value === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, value);
      } catch {}
      apply();
    },
  };
})();
