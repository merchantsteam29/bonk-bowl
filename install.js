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
