// sw.js - Complete offline-first service worker
const CACHE_NAME = "meridian-v1.1760";

const FILES_TO_CACHE = [
  "/",
  "/index.html",
  "/auth.html",
  "/course.html",
  "/media.html",
  "/teacher.html",
  "/teacher_course.html",
  "/admin.html",
  "/settings.html",
  "/live.html",
  "/manifest.json",
  // JS
  "/JS/session.js",
  "/JS/config.js",
  "/JS/supabase.js",
  "/JS/livekit.js",
  "/JS/S3.js",
  "/JS/offline-media.js",
  "/JS/db.js",
  "/JS/cache-janitor.js",
  "/JS/storage-monitor.js",
  // Assets
  "/assets/logo.svg",
  "/assets/logo-white.svg",
  "/assets/icons/favicon-32x32.png",
  "/assets/icons/favicon-16x16.png",
  "/assets/icons/apple-touch-icon.png",
  "/assets/icons/android-chrome-192x192.png",
  "/assets/icons/android-chrome-512x512.png",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  // Plyr
  "/dist/plyr/plyr.min.css",
  "/dist/plyr/plyr.min.js",
  "/dist/plyr/plyr.svg",
  // pdf.js
  "/dist/pdfjs/pdf.min.mjs",
  "/dist/pdfjs/pdf.worker.min.mjs",
  "/dist/pdfjs/pdf_viewer.css",
  // Auth background
  "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?q=80&w=1400&auto=format&fit=crop",
];

// Install - pre-cache everything before activating
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        for (const file of FILES_TO_CACHE) {
          try {
            await cache.add(file);
          } catch (err) {
            console.warn(`[SW] Failed to pre-cache ${file}:`, err);
          }
        }
      })
      .then(() => self.skipWaiting()) // skip AFTER caching done
  );
});

// Activate - delete old caches, claim all clients immediately
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => {
            console.log("[SW] Deleting old cache:", key);
            return caches.delete(key);
          })
        )
      ),
      clients.claim(),
    ])
  );
});

// Fetch strategy:
//   HEAD + Range requests → always network (needed for chunked video download)
//   HTML pages            → cache-first with network refresh (works offline from restart)
//   Everything else       → cache-first
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    event.respondWith(fetch(event.request));
    return;
  }

  const url = new URL(event.request.url);

  // Cross-origin API/SDK traffic (Firebase Auth, Firestore, Supabase, etc.)
  // must never be touched by the SW. These aren't cacheable page assets —
  // they're live API calls with their own auth/streaming semantics, and a
  // SW trying to cache them causes CORS failures (the browser blocks an SW
  // from caching a cross-origin response it doesn't have proper access to).
  if (url.origin !== self.location.origin) {
    return; // let the browser handle it normally, completely bypassing the SW
  }

  // Let HEAD and Range requests bypass SW — needed for _getFileSize() in offline-media.js
  // (cached responses strip Content-Length and Content-Range headers)
  const rangeHeader = event.request.headers.get("Range");
  if (event.request.method === "HEAD" || rangeHeader) {
    event.respondWith(fetch(event.request));
    return;
  }

  // admin.html is never cached — always fresh from network.
  // It manages live data (users, enrollments, assignments) and was never
  // meant to work offline; serving a stale cached copy here causes
  // changes (assign/remove/etc) to appear delayed or missing until a
  // hard refresh happens to race past the SW cache.
  if (url.pathname.endsWith("/admin.html")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  const isHTML = event.request.mode === "navigate" ||
                 url.pathname.endsWith(".html") ||
                 url.pathname === "/";

  if (isHTML) {
    // Cache-first for HTML — works on restart with no internet (no DNS needed)
    // Background-refresh cache so next load gets fresh version
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request, { cache: "no-store" })
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          })
          .catch(() => cached); // network failed — already returned cached above

        // Return cache immediately if we have it, otherwise wait for network
        return cached || networkFetch;
      })
    );
  } else {
    // Cache-first: JS, CSS, fonts, assets
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        }).catch(() => new Response("Offline - Content not cached", {
          status: 503,
          statusText: "Service Unavailable",
        }));
      })
    );
  }
});