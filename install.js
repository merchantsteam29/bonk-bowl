// Install as an app: shows the #installApp button when the browser offers to install
// (Chrome / Edge / Android; on iPhone use Share > Add to Home Screen), and registers the
// offline service worker. Skipped in automated tests (?test).
(() => {
  let evt = null;
  const btn = () => document.getElementById('installApp');
  const show = (on) => { const b = btn(); if (b) b.style.display = on ? '' : 'none'; };
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); evt = e; show(true); });
  addEventListener('appinstalled', () => { evt = null; show(false); });
  document.addEventListener('click', async (e) => {
    if (!evt || !e.target.closest || !e.target.closest('#installApp')) return;
    const p = evt; evt = null; show(false);
    p.prompt(); await p.userChoice.catch(() => {});
  });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !/[?&]test\b/.test(location.search)) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// "Download for PC": the Game Library app for Windows (every game in one place). Hidden on phones
// and tablets, and inside the app itself.
(() => {
  const b = document.getElementById('pcDownload'); if (!b) return;
  const ua = navigator.userAgent;
  if (/Electron|Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1)) { b.style.display = 'none'; return; }
  b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); location.href = 'https://github.com/merchantsteam29/GameLibrary/releases/latest/download/GameLibrary.exe'; });
})();
