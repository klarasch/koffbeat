// Koffbeat's service worker: keeps a copy of the whole app on the device, so the home-screen
// app opens and plays without a connection. The build (vite.config.ts) fills in the file list
// and a version; a new version caches its files, takes over, and drops the old copy.

const CACHE = "koffbeat-__VERSION__";
const FILES = __FILES__;
/** How long to wait for the network before opening the saved copy of the page. */
const NETWORK_WAIT_MS = 2500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("koffbeat-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // The page: from the network when it answers quickly (so a new version shows at once),
    // otherwise the saved copy.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const saved = () => cache.match("./").then((r) => r || cache.match("index.html"));
        const network = fetch(request).then((response) => {
          if (response.ok) void cache.put("./", response.clone());
          return response;
        });
        const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS)).then(saved);
        try {
          return (await Promise.race([network, timeout])) || (await network);
        } catch {
          return (await saved()) || Response.error();
        }
      })(),
    );
    return;
  }

  // Everything else has a content hash in its name (or comes with the version): saved copy first.
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)));
});
