/* Precaches just the app shell — designs/wishlist data is already
   local-first via localStorage/Firestore, so there's nothing else here
   worth caching. Firebase's CDN scripts are loaded on demand elsewhere
   and deliberately left out: they should fail gracefully offline (sync
   just won't work without a connection), not get force-cached stale. */
const CACHE_NAME = "nail-journal-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(SHELL_FILES); })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); }));
    })
  );
  self.clients.claim();
});

/* Network-first for shell files (so a new deploy shows up on next load),
   falling back to the cached copy only when offline. Firestore/Storage/
   Firebase CDN requests are left completely untouched. */
self.addEventListener("fetch", function (event) {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const isShellFile = SHELL_FILES.some(function (f) {
    return url.pathname === new URL(f, self.location.href).pathname;
  });
  if (!isShellFile) return;

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        return response;
      })
      .catch(function () { return caches.match(event.request); })
  );
});
