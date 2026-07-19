/**
 * S3.js — Meridian Storage Client
 *
 * Upload:   MediaUploader — splits file into 5 MB chunks → media-upload edge fn
 *           → Supabase Storage (lecture-media bucket). Unchanged.
 *
 * Playback: mountVideoPlayer — registers Firebase token with SW, sets
 *           video.src = /virtual-video/{assetId}. SW intercepts Plyr's Range
 *           requests, fetches correct chunks from media-proxy, slices bytes,
 *           returns 206. No blob assembly needed for streaming.
 *
 * Offline:  MediaDownloader — downloads all chunks into IDB, assembles blob URL
 *           for offline playback (no SW needed once downloaded).
 *
 * PDF:      fetchPdf — unchanged, proxy fetch → IDB cache → blob URL.
 *
 * USAGE — Upload (teacher):
 *   import { MediaUploader } from "./S3.js";
 *   const up = new MediaUploader(file, { lectureId, courseId, type: "video" });
 *   up.onProgress = pct => updateBar(pct);
 *   up.onComplete = ({ assetId }) => saveLecture(assetId);
 *   await up.start();
 *
 * USAGE — Stream (student, online):
 *   import { mountVideoPlayer } from "./S3.js";
 *   const player = await mountVideoPlayer(assetId, "player-container");
 *
 * USAGE — Offline download:
 *   import { MediaDownloader } from "./S3.js";
 *   const dl = new MediaDownloader(assetId, { type: "video", totalChunks: 12 });
 *   dl.onProgress = pct => updateBar(pct);
 *   dl.onComplete = blobUrl => player.src = blobUrl;
 *   await dl.start();
 *
 * USAGE — PDF:
 *   import { fetchPdf } from "./S3.js";
 *   const blobUrl = await fetchPdf(assetId);
 */

import { getById, put, deleteById, getByIndex } from "./db.js";
import { SUPABASE_URL, getConfig } from "./config.js";

const PROXY_BASE        = `${SUPABASE_URL}/functions/v1/media-proxy`;
const UPLOAD_BASE       = `${SUPABASE_URL}/functions/v1/media-upload`;
const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB — must match edge fn + SW

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function getToken() {
  const { getAuth, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const auth = getAuth();
  if (auth.currentUser) return auth.currentUser.getIdToken();
  // Wait for auth state to restore (up to 5s)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Not authenticated")), 5000);
    const unsub = onAuthStateChanged(auth, user => {
      unsub();
      clearTimeout(t);
      if (user) resolve(user.getIdToken());
      else reject(new Error("Not authenticated"));
    });
  });
}

async function authHeader() {
  const token           = await getToken();
  const { supabaseKey } = await getConfig(token).catch(() => ({ supabaseKey: "" }));
  return { Authorization: `Bearer ${token}`, apikey: supabaseKey };
}

// ─── MediaUploader ─────────────────────────────────────────────────────────────
// Slices file into 5 MB chunks, POSTs each to media-upload edge fn.
// FIX: added per-chunk retry with exponential backoff (3 attempts).
//      Previously a single transient failure silently aborted the upload,
//      leaving storage_assets.status = "uploading" and proxy returning 404.
export class MediaUploader {
  constructor(file, opts = {}) {
    this.file       = file;
    this.courseId   = opts.courseId;
    this.type       = opts.type || (file.type.includes("pdf") ? "pdf" : "video");
    this.assetId    = opts.assetId || opts.lectureId || crypto.randomUUID();
    this._cancelled = false;
    this.onProgress = null; // (percent: number) => void
    this.onComplete = null; // ({ assetId: string }) => void
    this.onError    = null; // (err: Error) => void
  }

  // ── Internal: upload one chunk with retry ──────────────────────────────────
  async _uploadChunk(form, headers, chunkIndex, maxRetries = 3) {
    let lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (this._cancelled) return;
      try {
        // Re-fetch a fresh token on retry — original may have been close to expiry
        const hdrs = attempt === 0 ? headers : await authHeader();
        const res  = await fetch(UPLOAD_BASE, { method: "POST", headers: hdrs, body: form });
        if (res.ok) return;
        const body = await res.text();
        lastErr = new Error(`Chunk ${chunkIndex} failed (${res.status}): ${body}`);
        // 4xx (except 429) won't recover — bail immediately
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw lastErr;
      } catch (e) {
        lastErr = e;
      }
      if (attempt < maxRetries - 1) {
        // Exponential backoff: 1s, 2s, 4s …
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  }

  async start() {
    try {
      const totalChunks = Math.ceil(this.file.size / UPLOAD_CHUNK_SIZE);
      const headers     = await authHeader();

      for (let i = 0; i < totalChunks; i++) {
        if (this._cancelled) return;

        const start = i * UPLOAD_CHUNK_SIZE;
        const chunk = this.file.slice(start, Math.min(start + UPLOAD_CHUNK_SIZE, this.file.size));

        const form = new FormData();
        form.append("file",        chunk, `chunk-${i}`);
        form.append("assetId",     this.assetId);
        form.append("chunkIndex",  String(i));
        form.append("totalChunks", String(totalChunks));
        form.append("mimeType",    this.file.type || "video/mp4");
        form.append("type",        this.type);
        form.append("courseId",    this.courseId || "");

        await this._uploadChunk(form, headers, i);

        if (this.onProgress) this.onProgress(Math.round(((i + 1) / totalChunks) * 100));
      }

      if (this.onComplete) this.onComplete({ assetId: this.assetId });
    } catch (e) {
      if (this.onError) this.onError(e); else throw e;
    }
  }

  cancel() { this._cancelled = true; }
}

// ─── mountVideoPlayer ──────────────────────────────────────────────────────────
// Streaming playback via SW virtual filesystem. No full download required.
// Plyr sends Range requests to /virtual-video/{assetId} → SW intercepts →
// fetches chunks from proxy → slices bytes → returns 206.
//
// Call BEFORE setting video.src (SW needs token registered first).
//
// Returns the Plyr instance.
export async function mountVideoPlayer(assetId, containerId) {
  if (!assetId) throw new Error("mountVideoPlayer: assetId required");

  // ── Register token with SW ─────────────────────────────────────────────────
  const token = await getToken();

  if (!navigator.serviceWorker?.controller) {
    await new Promise(resolve => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      setTimeout(resolve, 4000);
    });
  }
  // Fetch totalChunks from storage_assets (needs RLS: authenticated users SELECT)
  let totalChunks = 1;
  try {
    const { supabaseKey } = await getConfig(token).catch(() => ({ supabaseKey: "" }));
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/storage_assets?id=eq.${encodeURIComponent(assetId)}&select=total_chunks`,
      { headers: { Authorization: `Bearer ${token}`, apikey: supabaseKey } }
    );
    if (res.ok) {
      const [row] = await res.json();
      if (row?.total_chunks) totalChunks = row.total_chunks;
    }
  } catch {}

  const msg = { type: "REGISTER_VIDEO_TOKEN", assetId, token };
  if (totalChunks > 1) msg.totalChunks = totalChunks;
  navigator.serviceWorker.controller?.postMessage(msg);

  // ── Build container ────────────────────────────────────────────────────────
  const container = typeof containerId === "string"
    ? document.getElementById(containerId)
    : containerId;
  if (!container) throw new Error(`Container not found: ${containerId}`);

  container.innerHTML = "";
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.setAttribute("controls", "");
  container.appendChild(video);

  // ── Init Plyr ──────────────────────────────────────────────────────────────
  // Plyr is loaded globally via /dist/plyr/plyr.min.js
  const player = new Plyr(video, {
    controls: ["play-large", "play", "progress", "current-time", "mute", "volume", "fullscreen"],
  });

  // Delay so SW receives totalChunks postMessage first
  await new Promise(r => setTimeout(r, 500));

  // Set src AFTER Plyr wraps the element
  player.source = {
    type:    "video",
    sources: [{ src: `/virtual-video/${assetId}`, type: "video/mp4" }],
  };

  // ── Refresh token every 50 min (Firebase tokens expire at 1 h) ────────────
  const refreshInterval = setInterval(async () => {
    try {
      const { getAuth } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
      const fresh = await getAuth().currentUser?.getIdToken(true);
      if (fresh && navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "REGISTER_VIDEO_TOKEN",
          assetId,
          token: fresh,
        });
      }
    } catch {}
  }, 50 * 60 * 1000);

  player.on("destroy", () => clearInterval(refreshInterval));

  return player;
}

// ─── MediaDownloader ───────────────────────────────────────────────────────────
// Offline download: fetches all chunks into IDB, assembles a blob URL.
// Used by the "Download for offline" button — not for live streaming.
export class MediaDownloader {
  constructor(assetId, opts = {}) {
    this.assetId     = assetId;
    this.type        = opts.type || "video";
    this.totalChunks = opts.totalChunks || 1;
    this._cancelled  = false;
    this._running    = false;
    this.onProgress  = null; // (percent: number) => void
    this.onComplete  = null; // (blobUrl: string) => void
    this.onError     = null; // (err: Error) => void
  }

  async start() {
    if (this._running) return;
    this._running   = true;
    this._cancelled = false;

    try {
      const existing   = await getByIndex("video_chunks", "by_lecture", this.assetId);
      const downloaded = new Set(existing.map(c => c.chunkIndex));
      const headers    = await authHeader();

      for (let i = 0; i < this.totalChunks; i++) {
        if (this._cancelled) { this._running = false; return; }
        if (downloaded.has(i)) continue;

        const res = await fetch(
          `${PROXY_BASE}?assetId=${encodeURIComponent(this.assetId)}&chunk=${i}`,
          { headers }
        );
        if (!res.ok) throw new Error(`Chunk ${i} failed: ${res.status}`);

        await put("video_chunks", {
          chunkId:    `${this.assetId}_${i}`,
          lectureId:  this.assetId,
          chunkIndex: i,
          blob:       await res.blob(),
        });

        if (this.onProgress) this.onProgress(Math.round(((i + 1) / this.totalChunks) * 100));
      }

      await put("download_metadata", {
        lectureId:        this.assetId,
        status:           "complete",
        totalChunks:      this.totalChunks,
        downloadedChunks: [...Array(this.totalChunks).keys()],
        progress:         100,
        completedAt:      Date.now(),
      });

      if (this.onComplete) this.onComplete(await this._assembleBlob());
    } catch (e) {
      this._running = false;
      if (this.onError) this.onError(e); else throw e;
    }
    this._running = false;
  }

  cancel() { this._cancelled = true; }

  async getPlayableBlob() {
    const meta = await getById("download_metadata", this.assetId);
    if (meta?.status !== "complete") return null;
    return this._assembleBlob();
  }

  async _assembleBlob() {
    const chunks = await getByIndex("video_chunks", "by_lecture", this.assetId);
    if (!chunks.length) return null;
    chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const mime = this.type === "pdf" ? "application/pdf" : "video/mp4";
    return URL.createObjectURL(new Blob(chunks.map(c => c.blob), { type: mime }));
  }

  static async deleteOfflineAsset(assetId) {
    const chunks = await getByIndex("video_chunks", "by_lecture", assetId);
    for (const c of chunks) await deleteById("video_chunks", c.chunkId);
    await deleteById("download_metadata", assetId);
  }

  static async getStatus(assetId) {
    const meta = await getById("download_metadata", assetId);
    if (!meta) return { status: null, progress: 0 };
    return { status: meta.status, progress: meta.progress || 0 };
  }
}

// ─── fetchPdf ─────────────────────────────────────────────────────────────────
export async function fetchPdf(assetId) {
  const meta = await getById("download_metadata", assetId);
  if (meta?.status === "complete") {
    return new MediaDownloader(assetId, { type: "pdf", totalChunks: 1 })._assembleBlob();
  }

  const headers = await authHeader();
  const res     = await fetch(`${PROXY_BASE}?assetId=${encodeURIComponent(assetId)}`, { headers });
  if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`);

  const blob = await res.blob();
  await put("video_chunks",      { chunkId: `${assetId}_0`, lectureId: assetId, chunkIndex: 0, blob });
  await put("download_metadata", { lectureId: assetId, status: "complete", totalChunks: 1, progress: 100, completedAt: Date.now() });

  return URL.createObjectURL(blob);
}