/* Yalnızca uygulama kabuğu önbelleklenir. Hasta verisi (Google API yanıtları) ASLA önbelleğe alınmaz. */
var CACHE = 'hasta-arama-v9';
var SHELL = ['./', 'index.html', 'core.js', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // Google API'lerine dokunma
  // Önce ağ (güncel sürüm; tarayıcının HTTP önbelleği atlanır), ağ yoksa önbellek
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(function (r) {
    var copy = r.clone();
    caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    return r;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
