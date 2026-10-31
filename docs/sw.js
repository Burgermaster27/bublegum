// Офлайн-кэш: при первом открытии всё сохраняется на устройстве, дальше игра работает без интернета
const CACHE = 'postroy-samolet-f72f1232c9';
const FILES = ['./', 'index.html', 'game.bundle.js', 'manifest.webmanifest', 'icon192.png', 'icon512.png', 'icon180.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
