// Service worker: lets the installed app open with no signal.
// - Pages: try the network first; if offline, show the last saved copy.
// - App code (/_next/static): saved on first use; file names change on every
//   deploy, so a saved copy is never stale.
// - Supabase and other outside requests are never touched.
const VERSION = "v1";
const PAGES = `pages-${VERSION}`;
const ASSETS = `assets-${VERSION}`;
const APP_PAGES = ["/", "/checkin", "/login"];
const STATIC_FILES = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/rera-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const pages = await caches.open(PAGES);
      await Promise.all(APP_PAGES.map((u) => pages.add(new Request(u, { cache: "reload" })).catch(() => {})));
      const assets = await caches.open(ASSETS);
      await Promise.all(STATIC_FILES.map((u) => assets.add(u).catch(() => {})));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = [PAGES, ASSETS];
      for (const key of await caches.keys()) {
        if (!keep.includes(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

// The page tells us which app-code files it loaded, so they're saved even from
// the very first visit (before this worker was in control).
self.addEventListener("message", (event) => {
  const urls = event.data && event.data.type === "CACHE_URLS" ? event.data.urls : null;
  if (!Array.isArray(urls)) return;
  event.waitUntil(
    (async () => {
      const assets = await caches.open(ASSETS);
      for (const u of urls) {
        try {
          const url = new URL(u, self.location.origin);
          if (url.origin !== self.location.origin) continue;
          if (!(await assets.match(url.href))) await assets.add(url.href);
        } catch (e) {}
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: save once, reuse offline.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(req, ASSETS));
    return;
  }
  if (url.origin !== self.location.origin) return; // Supabase etc. go straight to the network

  if (req.mode === "navigate") {
    event.respondWith(networkFirstPage(req));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || STATIC_FILES.includes(url.pathname)) {
    event.respondWith(cacheFirst(req, ASSETS));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
  return res;
}

async function networkFirstPage(req) {
  const cache = await caches.open(PAGES);
  const url = new URL(req.url);
  try {
    const res = await fetch(req);
    // keep an offline copy of coordinator screens only; admin pages always need live data
    if (res && res.ok && !url.pathname.startsWith("/admin")) cache.put(url.pathname, res.clone());
    return res;
  } catch (e) {
    const saved = await cache.match(url.pathname);
    if (saved) return saved;
    // Admin pages need live data; say so instead of showing a different screen.
    if (!url.pathname.startsWith("/admin")) {
      const fallback = (await cache.match("/checkin")) || (await cache.match("/"));
      if (fallback) return fallback;
    }
    return offlinePage(
      url.pathname.startsWith("/admin")
        ? "Admin pages need a connection. They'll work again once you're back online."
        : "Open the app once while connected so it can work offline next time."
    );
  }
}

function offlinePage(message) {
  return new Response(
    "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>Offline</title></head>" +
      "<body style='font-family:system-ui,sans-serif;background:#F6F8EF;color:#061C3B;padding:32px 20px;text-align:center'>" +
      "<img src='/rera-icon.png' alt='' style='height:56px;margin-bottom:16px'>" +
      "<h2 style='margin:0 0 8px'>You're offline</h2><p style='color:#7C879B'>" + message + "</p>" +
      "<button onclick='location.reload()' style='margin-top:12px;padding:12px 20px;border:0;border-radius:10px;background:#1A6BA3;color:#fff;font-weight:700'>Try again</button>" +
      "</body></html>",
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
