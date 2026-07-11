/**
 * storage.js — Meridian Storage Client
 *
 * Unified media pipeline for video and PDFs.
 * Uploads to GitHub Releases via Supabase Edge Functions.
 * Downloads via authenticated proxy with range request support.
 * Caches chunks in IndexedDB for offline playback — same pattern as offline-media.js.
 *
 * SWAP BACKENDS: change PROXY_BASE and UPLOAD_BASE to point at
 * Bunny.net / your own server / S3 — nothing else changes.
 *
 * USAGE — Upload (teacher):
 *   import { MediaUploader } from "./storage.js";
 *   const up = new MediaUploader(file, { lectureId, courseId, type: "video" });
 *   up.onProgress = (pct) => console.log(pct + "%");
 *   up.onComplete = ({ assetId }) => console.log("done", assetId);
 *   await up.start();
 *
 * USAGE — Stream/download (student):
 *   import { MediaDownloader } from "./storage.js";
 *   const dl = new MediaDownloader(assetId, { type: "video", totalChunks: 10 });
 *   dl.onProgress = (pct) => updateBar(pct);
 *   dl.onComplete = (blobUrl) => player.src = blobUrl;
 *   await dl.start();
 *
 * USAGE — PDF:
 *   import { fetchPdf } from "./storage.js";
 *   const blobUrl = await fetchPdf(assetId); // cached after first fetch
 */

import { getById, put, deleteById, getByIndex } from "./db.js";
import { getSession } from "./session.js";

// ─── Config — swap these to change backend ────────────────────────────────────
const SUPABASE_URL  = "https://fzkpmptsnnkafaaeqhnf.supabase.co";
const SUPABASE_KEY  = "sb_publishable_Sw15oAmzk8DDUiwOe8mU8A_g-ZHg5EO";
const PROXY_BASE    = `${SUPABASE_URL}/functions/v1/media-proxy`;
const UPLOAD_BASE   = `${SUPABASE_URL}/functions/v1/media-upload`;

// Chunk size for uploads — 5 MB matches LiveKit egress chunk cadence
const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB

// ─── Auth header ──────────────────────────────────────────────────────────────
async function authHeader() {
  // Get Firebase ID token from the active session
  const { getAuth } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const auth  = getAuth();
  const user  = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    apikey:        SUPABASE_KEY,
  };
}

// ─── MediaUploader ────────────────────────────────────────────────────────────
/**
 * Uploads a File in chunks to GitHub Releases via the media-upload edge function.
 * Works for both VOD video (MP4) and PDFs.
 */
export class MediaUploader {
  /**
   * @param {File}   file
   * @param {{ lectureId?: string, courseId: string, type: "video"|"pdf", assetId?: string }} opts
   */
  constructor(file, opts = {}) {
    this.file       = file;
    this.courseId   = opts.courseId;
    this.type       = opts.type || (file.type.includes("pdf") ? "pdf" : "video");
    // Stable ID — use lectureId if given, else generate one
    this.assetId    = opts.assetId || opts.lectureId || crypto.randomUUID();
    this._cancelled = false;

    /** @type {(percent: number) => void} */
    this.onProgress = null;
    /** @type {({ assetId: string }) => void} */
    this.onComplete = null;
    /** @type {(err: Error) => void} */
    this.onError    = null;
  }

  async start() {
    try {
      const totalChunks = Math.ceil(this.file.size / UPLOAD_CHUNK_SIZE);
      const headers     = await authHeader();

      for (let i = 0; i < totalChunks; i++) {
        if (this._cancelled) return;

        const start = i * UPLOAD_CHUNK_SIZE;
        const end   = Math.min(start + UPLOAD_CHUNK_SIZE, this.file.size);
        const chunk = this.file.slice(start, end);

        const form = new FormData();
        form.append("file",        chunk, `chunk-${i}`);
        form.append("assetId",     this.assetId);
        form.append("chunkIndex",  String(i));
        form.append("totalChunks", String(totalChunks));
        form.append("mimeType",    this.file.type || "application/octet-stream");
        form.append("type",        this.type);
        form.append("courseId",    this.courseId || "");

        const res = await fetch(UPLOAD_BASE, {
          method:  "POST",
          headers, // no Content-Type — browser sets multipart boundary
          body:    form,
        });
        if (!res.ok) throw new Error(`Upload chunk ${i} failed: ${await res.text()}`);

        const pct = Math.round(((i + 1) / totalChunks) * 100);
        if (this.onProgress) this.onProgress(pct);
      }

      if (this.onComplete) this.onComplete({ assetId: this.assetId });
    } catch (e) {
      if (this.onError) this.onError(e);
      else throw e;
    }
  }

  cancel() { this._cancelled = true; }
}

// ─── MediaDownloader ───────────────────────────────────────────────────────────
/**
 * Downloads a video asset chunk by chunk via the proxy, stores in IndexedDB.
 * Extends the offline-media.js pattern — same IDB stores, same blob assembly.
 * Supports resumable downloads.
 */
export class MediaDownloader {
  /**
   * @param {string} assetId
   * @param {{ type: "video"|"pdf", totalChunks: number }} opts
   */
  constructor(assetId, opts = {}) {
    this.assetId     = assetId;
    this.type        = opts.type || "video";
    this.totalChunks = opts.totalChunks || 1;
    this._cancelled  = false;
    this._running    = false;

    /** @type {(percent: number) => void} */
    this.onProgress = null;
    /** @type {(blobUrl: string) => void} */
    this.onComplete = null;
    /** @type {(err: Error) => void} */
    this.onError    = null;
  }

  async start() {
    if (this._running) return;
    this._running   = true;
    this._cancelled = false;

    try {
      // Check existing chunks in IDB
      const existing = await getByIndex("video_chunks", "by_lecture", this.assetId);
      const downloaded = new Set(existing.map(c => c.chunkIndex));

      const headers = await authHeader();

      for (let i = 0; i < this.totalChunks; i++) {
        if (this._cancelled) { this._running = false; return; }
        if (downloaded.has(i)) continue; // already cached

        const url = `${PROXY_BASE}?assetId=${encodeURIComponent(this.assetId)}&chunk=${i}`;
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`Proxy fetch chunk ${i} failed: ${res.status}`);

        const blob = await res.blob();
        await put("video_chunks", {
          id:          `${this.assetId}_${i}`,
          lectureId:   this.assetId,
          chunkIndex:  i,
          blob,
        });

        const pct = Math.round(((i + 1) / this.totalChunks) * 100);
        if (this.onProgress) this.onProgress(pct);
      }

      // Mark complete in download_metadata (same store as offline-media.js)
      await put("download_metadata", {
        id:               this.assetId,
        status:           "complete",
        totalChunks:      this.totalChunks,
        downloadedChunks: [...Array(this.totalChunks).keys()],
        progress:         100,
        completedAt:      Date.now(),
      });

      const blobUrl = await this._assembleBlob();
      if (this.onComplete) this.onComplete(blobUrl);
    } catch (e) {
      this._running = false;
      if (this.onError) this.onError(e);
      else throw e;
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
    const full = new Blob(chunks.map(c => c.blob), { type: mime });
    return URL.createObjectURL(full);
  }

  static async deleteOfflineAsset(assetId) {
    const chunks = await getByIndex("video_chunks", "by_lecture", assetId);
    for (const c of chunks) await deleteById("video_chunks", c.id);
    await deleteById("download_metadata", assetId);
  }

  static async getStatus(assetId) {
    const meta = await getById("download_metadata", assetId);
    if (!meta) return { status: null, progress: 0 };
    return { status: meta.status, progress: meta.progress || 0 };
  }
}

// ─── fetchPdf ─────────────────────────────────────────────────────────────────
/**
 * Fetches a PDF via the proxy, caches in IDB as a single chunk, returns blob URL.
 * On subsequent calls returns cached version without hitting the network.
 */
export async function fetchPdf(assetId) {
  // Check IDB cache first
  const meta = await getById("download_metadata", assetId);
  if (meta?.status === "complete") {
    const dl = new MediaDownloader(assetId, { type: "pdf", totalChunks: 1 });
    return dl._assembleBlob();
  }

  // Fetch via proxy
  const headers = await authHeader();
  const res     = await fetch(
    `${PROXY_BASE}?assetId=${encodeURIComponent(assetId)}`,
    { headers }
  );
  if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`);

  const blob = await res.blob();
  await put("video_chunks", {
    id:         `${assetId}_0`,
    lectureId:  assetId,
    chunkIndex: 0,
    blob,
  });
  await put("download_metadata", {
    id:           assetId,
    status:       "complete",
    totalChunks:  1,
    progress:     100,
    completedAt:  Date.now(),
  });

  return URL.createObjectURL(blob);
}

// ─── proxyUrl ─────────────────────────────────────────────────────────────────
/**
 * Returns a proxy URL for a given asset + chunk.
 * Use this for Plyr's src when you want authenticated streaming
 * without downloading the whole file first.
 *
 * Note: Plyr will send Range headers — the proxy passes them through to GitHub.
 */
export async function proxyUrl(assetId, chunkIndex = 0) {
  const headers = await authHeader();
  // Return both the URL and headers so the caller can configure their player
  return {
    url:     `${PROXY_BASE}?assetId=${encodeURIComponent(assetId)}&chunk=${chunkIndex}`,
    headers,
  };
}
