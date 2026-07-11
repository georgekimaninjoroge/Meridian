/**
 * storage-monitor.js — Meridian Storage Monitor
 *
 * ARCHITECTURE ROLE:
 *   Implements the Storage Monitor described in Architecture.txt.
 *   Tracks browser quota usage via navigator.storage.estimate().
 *   Writes snapshots to IndexedDB (storage_usage store).
 *   Warns student at 80% quota used.
 *   Blocks new video caching at 90% quota used.
 *   Notes still cache above 80% — only video is blocked at 90%.
 *
 * USAGE:
 *   import { StorageMonitor } from "./storage-monitor.js";
 *
 *   const monitor = new StorageMonitor();
 *
 *   // One-shot check
 *   const snapshot = await monitor.check();
 *   // → { usage, quota, percentUsed, level: "ok"|"warn"|"block" }
 *
 *   // Start polling every 60s + get a UI banner injected automatically
 *   monitor.start();
 *
 *   // Ask before caching a video
 *   if (await monitor.canCacheVideo()) { ... }
 *
 *   // Ask before caching a PDF/note
 *   if (await monitor.canCacheNotes()) { ... }
 *
 *   // Stop polling
 *   monitor.stop();
 *
 *   // Read last snapshot from IndexedDB (no network)
 *   const last = await StorageMonitor.getLastSnapshot();
 */

import { put, getById } from "./db.js";

// ─── Thresholds ───────────────────────────────────────────────────────────────
const WARN_PCT  = 80;  // show warning banner, stop video caching progress bar
const BLOCK_PCT = 90;  // hard block on new video chunk downloads

// ─── Poll interval ────────────────────────────────────────────────────────────
const DEFAULT_POLL_MS = 60 * 1000; // re-check every 60 s while page is open

// ─── StorageMonitor ───────────────────────────────────────────────────────────
export class StorageMonitor {
  constructor(pollMs = DEFAULT_POLL_MS) {
    this._pollMs   = pollMs;
    this._timerId  = null;
    this._bannerId = "meridian-storage-banner";

    /** @type {(snapshot: StorageSnapshot) => void} */
    this.onChange  = null;
  }

  // ── Public: one-shot check ─────────────────────────────────────────────────
  /**
   * Estimates current storage usage and writes a snapshot to IndexedDB.
   * @returns {Promise<StorageSnapshot>}
   */
  async check() {
    const snapshot = await this._estimate();
    await this._save(snapshot);
    this._updateBanner(snapshot);
    if (this.onChange) this.onChange(snapshot);
    return snapshot;
  }

  // ── Public: start polling ──────────────────────────────────────────────────
  /**
   * Runs check() immediately, then every pollMs milliseconds.
   * Injects a warning banner into the page if usage >= WARN_PCT.
   * Also requests persistent storage once — if granted, the browser
   * gives a disk-based quota instead of the ~2GB best-effort default.
   * Silently does nothing if the API is unavailable or denies the request.
   */
  start() {
    this._requestPersistence();
    this.check(); // immediate
    this._timerId = setInterval(() => this.check(), this._pollMs);
  }

  // ── Private: request persistent storage (best-effort, no UI prompt) ───────
  async _requestPersistence() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return;
      const already = await navigator.storage.persisted?.();
      if (already) return;
      const granted = await navigator.storage.persist();
      console.log(`[storage-monitor] Persistent storage ${granted ? "granted" : "not granted"}.`);
    } catch (err) {
      console.warn("[storage-monitor] Persistence request failed:", err);
    }
  }

  // ── Public: stop polling ───────────────────────────────────────────────────
  stop() {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  // ── Public: gate checks ────────────────────────────────────────────────────

  /**
   * Returns false if storage is >= BLOCK_PCT (hard block on video chunks).
   * Returns false if storage is >= WARN_PCT (soft block — warn + stop video).
   * Always check this before writing a video chunk to IndexedDB.
   */
  async canCacheVideo() {
    const snap = await this._estimate();
    return snap.percentUsed < WARN_PCT;
  }

  /**
   * Returns false only if storage is >= BLOCK_PCT.
   * Notes/PDFs are allowed up to 90% — only videos are blocked at 80%.
   */
  async canCacheNotes() {
    const snap = await this._estimate();
    return snap.percentUsed < BLOCK_PCT;
  }

  // ── Public: static — read last snapshot from IndexedDB ────────────────────
  /**
   * Returns the last saved snapshot (no network, no estimate call).
   * Useful in offline mode to show cached storage stats on the dashboard.
   * @returns {Promise<StorageSnapshot|null>}
   */
  static async getLastSnapshot() {
    return getById("storage_usage", "current");
  }

  // ── Private: estimate ──────────────────────────────────────────────────────
  async _estimate() {
    if (!navigator.storage || !navigator.storage.estimate) {
      // API unavailable — return safe defaults
      return {
        id:          "current",
        usage:       0,
        quota:       Infinity,
        percentUsed: 0,
        level:       "ok",
        timestamp:   Date.now(),
        available:   false,
      };
    }

    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const pct = quota > 0 ? Math.round((usage / quota) * 100) : 0;

    return {
      id:          "current",
      usage,
      quota,
      percentUsed: pct,
      level:       pct >= BLOCK_PCT ? "block" : pct >= WARN_PCT ? "warn" : "ok",
      timestamp:   Date.now(),
      available:   true,
    };
  }

  // ── Private: persist snapshot ──────────────────────────────────────────────
  async _save(snapshot) {
    try {
      await put("storage_usage", snapshot);
    } catch (err) {
      console.warn("[storage-monitor] Could not save snapshot:", err);
    }
  }

  // ── Private: banner UI ────────────────────────────────────────────────────
  _updateBanner(snapshot) {
    let banner = document.getElementById(this._bannerId);

    if (snapshot.level === "ok") {
      // Remove banner if it exists
      if (banner) banner.remove();
      return;
    }

    // Create banner if missing
    if (!banner) {
      banner = document.createElement("div");
      banner.id = this._bannerId;
      Object.assign(banner.style, {
        position:     "fixed",
        bottom:       "20px",
        left:         "50%",
        transform:    "translateX(-50%)",
        zIndex:       "9999",
        borderRadius: "16px",
        padding:      "14px 20px",
        fontFamily:   "'Inter', sans-serif",
        fontSize:     "13px",
        fontWeight:   "600",
        display:      "flex",
        alignItems:   "center",
        gap:          "12px",
        boxShadow:    "0 10px 30px rgba(0,0,0,.15)",
        maxWidth:     "480px",
        width:        "calc(100% - 40px)",
        cursor:       "pointer",
      });

      // Dismiss on click
      banner.addEventListener("click", () => banner.remove());
      document.body.appendChild(banner);
    }

    if (snapshot.level === "block") {
      // >= 90% — hard warning, red
      Object.assign(banner.style, {
        background: "#c24141",
        color:      "white",
      });
      banner.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>Storage ${snapshot.percentUsed}% full — video caching blocked. Delete old downloads to free space.</span>
      `;
    } else {
      // >= 80% — soft warning, amber
      Object.assign(banner.style, {
        background: "#f59e0b",
        color:      "white",
      });
      banner.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>Storage ${snapshot.percentUsed}% full — video caching paused. Notes still sync. Tap to dismiss.</span>
      `;
    }
  }
}

// ─── Convenience: format bytes for display ────────────────────────────────────
/**
 * Format raw bytes into a readable string e.g. "245 MB", "1.2 GB"
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || bytes === Infinity) return "—";
  if (bytes < 1024)                 return bytes + " B";
  if (bytes < 1024 * 1024)          return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)   return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/**
 * @typedef {Object} StorageSnapshot
 * @property {"current"} id
 * @property {number} usage        — bytes used
 * @property {number} quota        — bytes available
 * @property {number} percentUsed  — 0–100
 * @property {"ok"|"warn"|"block"} level
 * @property {number} timestamp    — ms since epoch
 * @property {boolean} available   — false if navigator.storage API not present
 */