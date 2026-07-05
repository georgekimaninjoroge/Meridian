/**
 * offline-media.js — Meridian Chunked Video Downloader
 *
 * ARCHITECTURE ROLE:
 *   Implements the Range Request Download Manager + Chunk Manager
 *   described in Architecture.txt.
 *
 *   Downloads an MP4 in 5 MB chunks using HTTP Range requests.
 *   Each chunk stored as a binary Blob in IndexedDB (video_chunks store).
 *   Download progress tracked in download_metadata store (resumable).
 *   When all chunks present → reassembles into a single Blob URL
 *   that the Plyr player in media.html can use for fully offline playback.
 *
 * NO SERVER PROCESSING — raw MP4 only. No FFmpeg, no HLS transcoding.
 * Works with the test.mp4 already cached by the service worker.
 *
 * USAGE:
 *   import { ChunkedVideoDownloader } from "./offline-media.js";
 *
 *   // Start or resume a download
 *   const dl = new ChunkedVideoDownloader("DCS311_W9", "/test.mp4");
 *   dl.onProgress = (pct) => console.log(pct + "% downloaded");
 *   dl.onComplete = (blobUrl) => player.source = { type:"video", sources:[{src:blobUrl}] };
 *   dl.onError    = (err) => console.error(err);
 *   await dl.start();
 *
 *   // Get a playable blob URL for a fully-downloaded lecture
 *   const url = await dl.getPlayableBlob();   // null if not complete
 *
 *   // Cancel an in-progress download
 *   dl.cancel();
 *
 *   // Delete all stored chunks (free space)
 *   await ChunkedVideoDownloader.deleteOfflineVideo("DCS311_W9");
 *
 *   // Check status without creating a downloader
 *   const status = await ChunkedVideoDownloader.getStatus("DCS311_W9");
 *   // → { status:"complete"|"downloading"|"paused"|"failed"|null, progress:100 }
 */

import { getById, put, deleteById, getByIndex, getDB } from "./db.js";
import { StorageMonitor } from "./storage-monitor.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB per chunk

// Shared monitor instance — one per page, reused across all downloaders
const _monitor = new StorageMonitor();

// ─── ChunkedVideoDownloader ───────────────────────────────────────────────────
export class ChunkedVideoDownloader {
  /**
   * @param {string} lectureId  — e.g. "DCS311_W9"
   * @param {string} videoUrl   — e.g. "/test.mp4"
   */
  constructor(lectureId, videoUrl) {
    this.lectureId  = lectureId;
    this.videoUrl   = videoUrl;
    this._cancelled = false;
    this._running   = false;

    // Callbacks — override before calling start()
    /** @type {(percent: number) => void} */
    this.onProgress = null;
    /** @type {(blobUrl: string) => void} */
    this.onComplete = null;
    /** @type {(error: Error) => void} */
    this.onError    = null;
  }

  // ── Public: start / resume ─────────────────────────────────────────────────
  /**
   * Start download. If partially done, resumes from last complete chunk.
   * Idempotent — safe to call again after cancel/error.
   */
  async start() {
    if (this._running) return;
    this._running   = true;
    this._cancelled = false;

    try {
      await this._run();
    } catch (err) {
      await this._setStatus("failed");
      if (this.onError) this.onError(err);
      console.error("[offline-media] Download failed:", err);
    } finally {
      this._running = false;
    }
  }

  // ── Public: cancel ─────────────────────────────────────────────────────────
  cancel() {
    this._cancelled = true;
  }

  // ── Public: get playable blob URL ──────────────────────────────────────────
  /**
   * Returns a blob: URL suitable for <video src> / Plyr.
   * Returns null if lecture not fully downloaded yet.
   * Caller is responsible for calling URL.revokeObjectURL() when done.
   */
  async getPlayableBlob() {
    const meta = await getById("download_metadata", this.lectureId);
    if (!meta || meta.status !== "complete") return null;
    return this._assembleBlob();
  }

  // ── Public: static helpers ─────────────────────────────────────────────────

  /** Check download status without creating a full downloader instance */
  static async getStatus(lectureId) {
    const meta = await getById("download_metadata", lectureId);
    if (!meta) return { status: null, progress: 0 };
    return { status: meta.status, progress: meta.progress || 0 };
  }

  /** Delete all stored chunks + metadata for a lecture (free storage) */
  static async deleteOfflineVideo(lectureId) {
    const db = await getDB();

    // Delete all chunks for this lecture
    const chunks = await getByIndex("video_chunks", "by_lecture", lectureId);
    for (const chunk of chunks) {
      await deleteById("video_chunks", chunk.chunkId);
    }

    // Delete metadata
    await deleteById("download_metadata", lectureId);
    console.log("[offline-media] Deleted offline video for:", lectureId);
  }

  // ── Private: core download logic ───────────────────────────────────────────
  async _run() {
    // 1. Get total file size via HEAD request
    const totalBytes = await this._getFileSize();
    if (totalBytes === 0) throw new Error("Could not determine file size — server may not support range requests.");

    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);

    // 2. Load existing metadata (resume support)
    let meta = await getById("download_metadata", this.lectureId);
    const downloaded = new Set(meta?.downloadedChunks || []);

    // Already complete?
    if (meta?.status === "complete" && downloaded.size === totalChunks) {
      this._emitProgress(100);
      const url = await this._assembleBlob();
      if (this.onComplete) this.onComplete(url);
      return;
    }

    // 3. Write / update metadata
    await put("download_metadata", {
      lectureId:        this.lectureId,
      status:           "downloading",
      totalChunks,
      downloadedChunks: [...downloaded],
      fileSize:         totalBytes,
      progress:         Math.round((downloaded.size / totalChunks) * 100),
      completedAt:      null,
    });

    this._emitProgress(Math.round((downloaded.size / totalChunks) * 100));

    // 4. Fetch missing chunks sequentially
    for (let i = 0; i < totalChunks; i++) {
      if (this._cancelled) {
        await this._setStatus("paused");
        return;
      }

      if (downloaded.has(i)) continue; // already stored

      // Storage gate — pause if quota >= 80% (warn) or >= 90% (block)
      if (!(await _monitor.canCacheVideo())) {
        console.warn("[offline-media] Storage threshold reached — pausing download.");
        await this._setStatus("paused");
        return;
      }

      const startByte = i * CHUNK_SIZE;
      const endByte   = Math.min(startByte + CHUNK_SIZE - 1, totalBytes - 1);

      const blob = await this._fetchChunk(startByte, endByte);

      await put("video_chunks", {
        chunkId:    `${this.lectureId}_chunk_${i}`,
        lectureId:  this.lectureId,
        chunkIndex: i,
        blob,
        startByte,
        endByte,
      });

      downloaded.add(i);

      // Update metadata after each chunk
      const progress = Math.round((downloaded.size / totalChunks) * 100);
      await put("download_metadata", {
        lectureId:        this.lectureId,
        status:           "downloading",
        totalChunks,
        downloadedChunks: [...downloaded],
        fileSize:         totalBytes,
        progress,
        completedAt:      null,
      });

      this._emitProgress(progress);
    }

    // 5. All chunks done → mark complete
    await put("download_metadata", {
      lectureId:        this.lectureId,
      status:           "complete",
      totalChunks,
      downloadedChunks: [...downloaded],
      fileSize:         totalBytes,
      progress:         100,
      completedAt:      Date.now(),
    });

    this._emitProgress(100);
    const blobUrl = await this._assembleBlob();
    if (this.onComplete) this.onComplete(blobUrl);
    console.log("[offline-media] Download complete:", this.lectureId);
  }

  // ── Private: HEAD request for total file size ──────────────────────────────
  async _getFileSize() {
    // cache:"no-store" bypasses SW cache so we get real server headers
    try {
      const res = await fetch(this.videoUrl, { method: "HEAD", cache: "no-store" });
      const len = res.headers.get("Content-Length");
      if (len) return parseInt(len, 10);
    } catch { /* fall through */ }

    // Fallback: try a zero-byte range request to read Content-Range total
    try {
      const res = await fetch(this.videoUrl, {
        headers: { Range: "bytes=0-0" },
        cache: "no-store"   // bypass SW — cached responses have no Content-Range
      });
      // Content-Range: bytes 0-0/12345678
      const cr = res.headers.get("Content-Range");
      if (cr) {
        const match = cr.match(/\/(\d+)$/);
        if (match) return parseInt(match[1], 10);
      }
    } catch { /* fall through */ }

    return 0;
  }

  // ── Private: fetch a single chunk ─────────────────────────────────────────
  async _fetchChunk(startByte, endByte) {
    const res = await fetch(this.videoUrl, {
      headers: { Range: `bytes=${startByte}-${endByte}` }
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`Range request failed: HTTP ${res.status} for bytes ${startByte}-${endByte}`);
    }

    return res.blob();
  }

  // ── Private: reassemble chunks into one Blob URL ───────────────────────────
  async _assembleBlob() {
    const chunks = await getByIndex("video_chunks", "by_lecture", this.lectureId);
    if (chunks.length === 0) return null;

    // Sort by chunkIndex to guarantee correct byte order
    chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

    const blobs   = chunks.map(c => c.blob);
    const full    = new Blob(blobs, { type: "video/mp4" });
    return URL.createObjectURL(full);
  }

  // ── Private: update status only ───────────────────────────────────────────
  async _setStatus(status) {
    const meta = await getById("download_metadata", this.lectureId);
    if (meta) {
      await put("download_metadata", { ...meta, status });
    }
  }

  // ── Private: emit progress ────────────────────────────────────────────────
  _emitProgress(pct) {
    if (this.onProgress) this.onProgress(pct);
  }
}

// ─── Convenience: get blob URL for already-downloaded lecture ─────────────────
/**
 * Quick helper — no need to instantiate the full downloader just to play back.
 *
 * @param {string} lectureId
 * @param {string} videoUrl  — only needed if you want to start a fresh download on miss
 * @returns {Promise<string|null>} blob URL or null
 */
export async function getOfflineBlobUrl(lectureId, videoUrl = null) {
  const meta = await getById("download_metadata", lectureId);
  if (meta?.status !== "complete") {
    // Not downloaded yet — optionally kick off a download
    if (videoUrl) {
      console.warn("[offline-media] Lecture not cached. Use ChunkedVideoDownloader.start() to download first.");
    }
    return null;
  }

  const dl = new ChunkedVideoDownloader(lectureId, videoUrl || "");
  return dl._assembleBlob();
}