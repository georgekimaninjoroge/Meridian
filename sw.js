// sw.js - Meridian Service Worker
// Offline-first + virtual video filesystem (chunked Supabase Storage → Range requests)
const CACHE_NAME = "meridian-v1.1770";

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

// ─── Virtual video config ──────────────────────────────────────────────────────
// Videos are served under /virtual-video/{assetId}
// The SW intercepts Range requests to this path, fetches 5 MB chunks from the
// proxy, and returns the correct byte slice — making it look like one big file.

const VIRTUAL_VIDEO_PREFIX = "/virtual-video/";
const CHUNK_SIZE            = 5 * 1024 * 1024; // must match upload chunk size
const PROXY_BASE            = "https://fzkpmptsnnkafaaeqhnf.supabase.co/functions/v1/media-proxy?v=2"; // same-origin edge fn

// In-memory chunk cache: key = "{assetId}:{chunkIndex}" → ArrayBuffer
// Survives the SW's lifetime, cleared when SW terminates.
// Prefetch populates this ahead of playback position.
const chunkCache = new Map();

// In-memory asset meta cache: assetId → { totalSize, totalChunks, mimeType }
// Populated on first HEAD-like request to /virtual-video/{assetId}
const assetMeta = new Map();

// ─── Parse Range header ────────────────────────────────────────────────────────
// Returns { start, end } (inclusive). end may be undefined (open-ended).
function parseRange(header, totalSize) {
  if (!header || !header.startsWith("bytes=")) return { start: 0, end: totalSize - 1 };
  const [, range]  = header.split("=");
  const [startStr, endStr] = range.split("-");
  const start = parseInt(startStr) || 0;
  const end   = endStr ? parseInt(endStr) : totalSize - 1;
  return { start, end: Math.min(end, totalSize - 1) };
}

// ─── Fetch one chunk from proxy (with in-memory cache) ────────────────────────
async function fetchChunk(assetId, chunkIndex, authToken) {
  const cacheKey = `${assetId}:${chunkIndex}`;
  if (chunkCache.has(cacheKey)) return chunkCache.get(cacheKey);

  const url = `${PROXY_BASE}&assetId=${encodeURIComponent(assetId)}&chunk=${chunkIndex}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!res.ok) throw new Error(`Proxy chunk ${chunkIndex} failed: ${res.status}`);

  const buf = await res.arrayBuffer();

  // Populate meta from response headers on first chunk
  if (!assetMeta.has(assetId)) {
    const totalChunks = parseInt(res.headers.get("X-Total-Chunks") || "1");
    const mimeType    = res.headers.get("X-Mime-Type") || "video/mp4";
    // We don't know exact totalSize yet — will refine from chunk sizes
    assetMeta.set(assetId, { totalChunks, mimeType, chunkSize: CHUNK_SIZE });
  }

  chunkCache.set(cacheKey, buf);

  // Limit cache size to 20 chunks (~100 MB) — evict oldest
  if (chunkCache.size > 20) {
    const firstKey = chunkCache.keys().next().value;
    chunkCache.delete(firstKey);
  }

  return buf;
}

// ─── Prefetch next N chunks in background ─────────────────────────────────────
function prefetchChunks(assetId, fromChunk, count, totalChunks, authToken) {
  for (let i = 1; i <= count; i++) {
    const next = fromChunk + i;
    if (next >= totalChunks) break;
    const key = `${assetId}:${next}`;
    if (!chunkCache.has(key)) {
      fetchChunk(assetId, next, authToken).catch(() => {}); // fire and forget
    }
  }
}

// ─── Handle virtual video Range request ───────────────────────────────────────
// Flow:
//   1. Parse Range header
//   2. Determine which chunks contain the requested bytes
//   3. Fetch only those chunks (parallel)
//   4. Slice + concatenate exact bytes
//   5. Return 206 Partial Content
async function handleVirtualVideo(request, assetId) {
  // Auth token: SW gets it from a custom header the page sets on the request.
  // The page uses: new Request('/virtual-video/...', { headers: { 'X-Auth': token } })
  // For Plyr (which uses <video src=...>), the page registers the token via postMessage.
  let authToken = request.headers.get("X-Auth") || swAuthTokens.get(assetId) || "";

  if (!authToken) {
    return new Response(JSON.stringify({ error: "No auth token for SW" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // ── Get asset meta (fetch chunk 0 if unknown) ────────────────────────────
    if (!assetMeta.has(assetId)) {
      await fetchChunk(assetId, 0, authToken);
    }
    const meta = assetMeta.get(assetId);
    if (!meta) return new Response("Asset not found", { status: 404 });

    const { totalChunks, mimeType } = meta;

    // ── Compute totalSize from chunks ────────────────────────────────────────
    // We approximate: (totalChunks - 1) * CHUNK_SIZE + lastChunkSize
    // Last chunk size = actual size of chunk (totalChunks-1), fetched lazily.
    // For Range parsing we need totalSize. Use stored value or fetch last chunk.
    if (!meta.totalSize) {
      const lastBuf = await fetchChunk(assetId, totalChunks - 1, authToken);
      meta.totalSize = (totalChunks - 1) * CHUNK_SIZE + lastBuf.byteLength;
      assetMeta.set(assetId, meta);
    }

    const totalSize = meta.totalSize;

    // ── Parse range ──────────────────────────────────────────────────────────
    const rangeHeader = request.headers.get("Range");
    const { start, end } = parseRange(rangeHeader, totalSize);
    const length = end - start + 1;

    // ── Determine chunks needed ──────────────────────────────────────────────
    const startChunk = Math.floor(start / CHUNK_SIZE);
    const endChunk   = Math.floor(end   / CHUNK_SIZE);

    // ── Fetch needed chunks in parallel ──────────────────────────────────────
    const chunkPromises = [];
    for (let i = startChunk; i <= endChunk; i++) {
      chunkPromises.push(fetchChunk(assetId, i, authToken));
    }
    const chunks = await Promise.all(chunkPromises);

    // ── Prefetch next 2 chunks in background ─────────────────────────────────
    prefetchChunks(assetId, endChunk, 2, totalChunks, authToken);

    // ── Assemble the exact byte range from chunks ─────────────────────────────
    const output = new Uint8Array(length);
    let outputOffset = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkIdx    = startChunk + i;
      const chunkStart  = chunkIdx * CHUNK_SIZE;  // byte offset of chunk start in full file
      const chunkBuf    = new Uint8Array(chunks[i]);

      // Which bytes of this chunk do we need?
      const sliceFrom = Math.max(0, start - chunkStart);
      const sliceTo   = Math.min(chunkBuf.byteLength, end - chunkStart + 1);

      output.set(chunkBuf.subarray(sliceFrom, sliceTo), outputOffset);
      outputOffset += sliceTo - sliceFrom;
    }

    return new Response(output.buffer, {
      status: 206,
      headers: {
        "Content-Type":    mimeType,
        "Content-Range":   `bytes ${start}-${end}/${totalSize}`,
        "Content-Length":  String(length),
        "Accept-Ranges":   "bytes",
        "Cache-Control":   "no-store",
      },
    });

  } catch (e) {
    console.error("[SW] virtual video error:", e);
    return new Response("Streaming error: " + e.message, { status: 500 });
  }
}

// ─── Token registry ───────────────────────────────────────────────────────────
// Plyr sets <video src="/virtual-video/{assetId}"> — no custom headers possible.
// The page sends auth tokens to the SW via postMessage before setting video.src.
// Map: assetId → token
const swAuthTokens = new Map();

self.addEventListener("message", (event) => {
  const { type, assetId, token, totalChunks } = event.data || {};
  if (type === "REGISTER_VIDEO_TOKEN" && assetId && token) {
    swAuthTokens.set(assetId, token);
    if (totalChunks && totalChunks > 1) {
      const existing = assetMeta.get(assetId) || {};
      assetMeta.set(assetId, { ...existing, totalChunks, mimeType: existing.mimeType || "video/mp4", chunkSize: CHUNK_SIZE });
    }
  }
});

// ─── Install ───────────────────────────────────────────────────────────────────
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
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────
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

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    event.respondWith(fetch(event.request));
    return;
  }

  const url = new URL(event.request.url);

  // ── Virtual video: intercept before cross-origin check ────────────────────
  // /virtual-video/{assetId} — same-origin, handles its own Range logic
  if (url.pathname.startsWith(VIRTUAL_VIDEO_PREFIX)) {
    const assetId = url.pathname.slice(VIRTUAL_VIDEO_PREFIX.length).split("/")[0];
    if (assetId) {
      event.respondWith(handleVirtualVideo(event.request, assetId));
      return;
    }
  }

  // ── Cross-origin: bypass entirely ─────────────────────────────────────────
  if (url.origin !== self.location.origin) {
    return;
  }

  // ── Range requests (non-virtual): bypass — PDFs, audio, etc. ─────────────
  const rangeHeader = event.request.headers.get("Range");
  if (event.request.method === "HEAD" || rangeHeader) {
    event.respondWith(fetch(event.request));
    return;
  }

  // ── admin.html: always network ────────────────────────────────────────────
  if (url.pathname.endsWith("/admin.html")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  // ── HTML: cache-first + background refresh ────────────────────────────────
  const isHTML = event.request.mode === "navigate" ||
                 url.pathname.endsWith(".html") ||
                 url.pathname === "/";

  if (isHTML) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request, { cache: "no-store" })
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  } else {
    // ── JS/CSS/assets: cache-first ───────────────────────────────────────────
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