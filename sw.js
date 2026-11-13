// À l’affût : le site s’ouvre comme une appli et reste lisible hors connexion.
// Toujours le réseau d’abord (la version publiée la plus récente), la copie gardée seulement sans connexion.
const CACHE = 'affut-v1';
const SHELL = ['./', 'manifest.webmanifest', 'logo/icone-192.png', 'logo/icone-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // Firebase, pochettes, extraits : pas touchés
  e.respondWith(fetch(req).then(res => {
    if (res.ok && (req.mode === 'navigate' || /\/data\/(releases|concerts|details)\.json$|\/logo\//.test(url.pathname))) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? './' : req, copy));
    }
    return res;
  }).catch(() => caches.match(req.mode === 'navigate' ? './' : req, { ignoreSearch: true }).then(r => r || Response.error())));
});
