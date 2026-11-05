/* OPD Roster service worker — keeps the app shell available offline */
"use strict";

const CACHE = "opd-static-v8";
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css?v=8",
  "./app.js?v=8"
];
const NET_TIMEOUT = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(PRECACHE.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  /* app data passes straight through to the network (data caching is handled in the app) */
  if (url.hostname === "iuddpeelzfpbuvyxrrec.supabase.co") return;

  /* page loads: newest over the network when possible, cached shell otherwise */
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await withTimeout(fetch(new Request(req, { cache: "no-store" })), NET_TIMEOUT);
        caches.open(CACHE).then(c => c.put("./index.html", fresh.clone()).catch(() => {}));
        return fresh;
      } catch (_) {
        const cached = await caches.match("./index.html", { ignoreSearch: true }) || await caches.match("./");
        if (cached) return cached;
        throw new Error("offline");
      }
    })());
    return;
  }

  /* same-origin assets: network-first, cache fallback */
  if (url.origin === location.origin) {
    event.respondWith((async () => {
      try {
        const fresh = await withTimeout(fetch(new Request(req, { cache: "no-store" })), NET_TIMEOUT);
        caches.open(CACHE).then(c => c.put(req, fresh.clone()).catch(() => {}));
        return fresh;
      } catch (_) {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response("offline", { status: 503 });
      }
    })());
    return;
  }

  /* fonts: cache-first (they never change in practice) */
  if (/fonts\.(gstatic|googleapis)\.com/.test(url.hostname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      caches.open(CACHE).then(c => c.put(req, fresh.clone()).catch(() => {}));
      return fresh;
    })());
  }
});
