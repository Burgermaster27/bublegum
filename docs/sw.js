// Офлайн-кэш: при первом открытии всё сохраняется на устройстве, дальше игра работает и без интернета
const CACHE = 'postroy-samolet-ea608a33e2';
const FILES = ['./', 'index.html', 'game.bundle.js', 'manifest.webmanifest', 'icon192.png', 'icon512.png', 'icon180.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
// Сначала сеть (чтобы обновления приходили сразу), без сети — сохранённая копия
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
