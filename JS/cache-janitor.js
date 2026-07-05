/**
 * cache-janitor.js — Meridian Cache Auto-Dump
 *
 * ARCHITECTURE ROLE:
 *   Implements activity-weighted TTL eviction for offline video chunks.
 *   Runs silently on app open and never touches content accessed recently.
 *
 * EVICTION RULES:
 *   Base TTL:       14 days since lastAccessedAt (reset on every play)
 *   Inactive app:   If app not opened in 7+ days → TTL halved (7 days)
 *   Fast-track:     Lectures with 100% course progress evict at 7 days
 *   Never evict:    Anything accessed within 48 hours
 *   Priority order: oldest lastAccessedAt → largest fileSize → completed courses
 *
 * USAGE:
 *   import { CacheJanitor } from "./cache-janitor.js";
 *   await CacheJanitor.run();   // call on app open — silent, no UI
 *
 *   // Optional: listen for what was evicted
 *   const evicted = await CacheJanitor.run();
 *   // → [{ lectureId, reason, freedBytes }, ...]
 */

import { getDB, getById, put, deleteById, getByIndex } from "./db.js";
import { ChunkedVideoDownloader } from "./offline-media.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const BASE_TTL_MS         = 14 * 24 * 60 * 60 * 1000;  // 14 days
const INACTIVE_TTL_MS     =  7 * 24 * 60 * 60 * 1000;  //  7 days (app inactive)
const FAST_TRACK_TTL_MS   =  7 * 24 * 60 * 60 * 1000;  //  7 days (course 100%)
const SAFE_WINDOW_MS      = 48 * 60 * 60 * 1000;        // 48 hours — never evict
const APP_INACTIVE_DAYS   = 7;                           // days without open → halve TTL
const LAST_OPEN_KEY       = "meridian_last_open";        // localStorage key

// ─── CacheJanitor ─────────────────────────────────────────────────────────────
export class CacheJanitor {

  /**
   * Main entry point. Call once on app open.
   * @returns {Promise<Array<{lectureId:string, reason:string, freedBytes:number}>>}
   */
  static async run() {
    // Stamp app open time before doing anything else
    const lastOpen = parseInt(localStorage.getItem(LAST_OPEN_KEY) || "0", 10);
    const now      = Date.now();
    localStorage.setItem(LAST_OPEN_KEY, String(now));

    // Did the student go inactive for 7+ days?
    const appInactive = lastOpen > 0 &&
      (now - lastOpen) > APP_INACTIVE_DAYS * 24 * 60 * 60 * 1000;

    let evicted = [];

    try {
      const db  = await getDB();
      const all = await CacheJanitor._getAllMetadata(db);

      for (const meta of all) {
        if (meta.status !== "complete") continue; // only evict fully downloaded

        const reason = CacheJanitor._shouldEvict(meta, now, appInactive);
        if (!reason) continue;

        await ChunkedVideoDownloader.deleteOfflineVideo(meta.lectureId);
        evicted.push({
          lectureId:  meta.lectureId,
          reason,
          freedBytes: meta.fileSize || 0,
        });

        console.log(`[cache-janitor] Evicted ${meta.lectureId} — ${reason}`);
      }
    } catch (err) {
      console.warn("[cache-janitor] Error during eviction scan:", err);
    }

    return evicted;
  }

  /**
   * Stamp lastAccessedAt on a lecture. Call this from media.html on play.
   * @param {string} lectureId
   */
  static async touch(lectureId) {
    try {
      const meta = await getById("download_metadata", lectureId);
      if (!meta) return;
      await put("download_metadata", { ...meta, lastAccessedAt: Date.now() });
    } catch (err) {
      console.warn("[cache-janitor] touch() failed:", err);
    }
  }

  // ── Private: decide whether to evict ──────────────────────────────────────
  /**
   * Returns eviction reason string, or null if should keep.
   */
  static _shouldEvict(meta, now, appInactive) {
    const lastAccess = meta.lastAccessedAt || meta.completedAt || 0;
    const age        = now - lastAccess;

    // Safe window — never touch recently accessed content
    if (age < SAFE_WINDOW_MS) return null;

    // Determine effective TTL
    let ttl = BASE_TTL_MS;

    if (appInactive) {
      // Student hasn't opened app in 7+ days — be more aggressive
      ttl = Math.min(ttl, INACTIVE_TTL_MS);
    }

    if (meta.courseProgress >= 100) {
      // Already finished the course — can afford to evict sooner
      ttl = Math.min(ttl, FAST_TRACK_TTL_MS);
    }

    if (age > ttl) {
      const days = Math.round(age / (24 * 60 * 60 * 1000));
      return `not accessed in ${days}d (TTL ${Math.round(ttl / 86400000)}d)`;
    }

    return null;
  }

  // ── Private: read all download_metadata records ───────────────────────────
  static async _getAllMetadata(db) {
    return new Promise((resolve, reject) => {
      const tx    = db.transaction("download_metadata", "readonly");
      const store = tx.objectStore("download_metadata");
      const req   = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }
}

// ─── Convenience: update courseProgress on a cached lecture ──────────────────
/**
 * Call this when course progress changes (e.g. student finishes all weeks).
 * Lets the janitor know it can fast-track eviction.
 *
 * @param {string} lectureId
 * @param {number} progressPct  — 0–100
 */
export async function setCourseProgress(lectureId, progressPct) {
  try {
    const meta = await getById("download_metadata", lectureId);
    if (!meta) return;
    await put("download_metadata", { ...meta, courseProgress: progressPct });
  } catch (err) {
    console.warn("[cache-janitor] setCourseProgress() failed:", err);
  }
}
