// Service worker de Vidoo: cachea solo el app shell estático (nunca los videos,
// que requieren auth y pueden ser enormes). Network-first con fallback a cache
// para no quedar pegado a una versión vieja del shell después de un deploy nuevo.
const CACHE_NAME = "vidoo-shell-v1";
const SHELL_FILES = ["./index.html", "./manifest.json", "./vidoo.webp"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!SHELL_FILES.some((f) => url.pathname.endsWith(f.replace("./", "")))) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
