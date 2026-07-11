// Minimal app-shell service worker: network-first with cache fallback for
// same-origin GETs. Enough for installability and offline reopening; the real
// work (photos, models) lives in IndexedDB, not here.
const CACHE = 'picbook-shell-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Pages must never be stale when online: bypass HTTP caches for navigations.
  const request = req.mode === 'navigate' ? new Request(req.url, { cache: 'no-store' }) : req;
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit ?? Response.error())),
  );
});
