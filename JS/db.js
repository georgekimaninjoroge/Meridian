/**
 * db.js — Meridian IndexedDB Wrapper
 *
 * ARCHITECTURE ROLE:
 *   Implements the IndexedDB layer described in Architecture.txt.
 *   UI reads from here, never directly from Firestore.
 *   Hardcoded seed data matches COURSES in course.html exactly.
 *   When Firestore is integrated later: replace seedIfEmpty() with
 *   a Firestore sync call — everything else stays the same.
 *
 * STORES:
 *   courses           — course metadata
 *   lectures          — per-week lecture entries (maps to COURSES[x].weeks)
 *   assignments       — per-course assessments
 *   announcements     — course announcements
 *   video_chunks      — binary blobs (5 MB each), written by offline-media.js
 *   pdf_blobs         — complete PDF blobs
 *   download_metadata — chunk download progress (resumable)
 *   storage_usage     — quota snapshots, written by storage-monitor.js
 *
 * USAGE:
 *   import { db, getAll, getById, put, deleteById } from "./db.js";
 *   const courses = await getAll("courses");
 *   const course  = await getById("courses", "DCS311");
 *   await put("download_metadata", { lectureId: "DCS311_W9", status: "complete", ... });
 */

// ─── DB Config ────────────────────────────────────────────────────────────────
const DB_NAME    = "meridian_lms";
const DB_VERSION = 2;

// ─── Open / Upgrade ───────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // courses — keyPath: id  e.g. "DCS311"
      if (!db.objectStoreNames.contains("courses")) {
        db.createObjectStore("courses", { keyPath: "id" });
      }

      // lectures — keyPath: id  e.g. "DCS311_W9"
      if (!db.objectStoreNames.contains("lectures")) {
        const ls = db.createObjectStore("lectures", { keyPath: "id" });
        ls.createIndex("by_course", "courseId", { unique: false });
      }

      // assignments — keyPath: id  e.g. "DCS311_HW1"
      if (!db.objectStoreNames.contains("assignments")) {
        const as = db.createObjectStore("assignments", { keyPath: "id" });
        as.createIndex("by_course", "courseId", { unique: false });
      }

      // announcements — keyPath: id
      if (!db.objectStoreNames.contains("announcements")) {
        const an = db.createObjectStore("announcements", { keyPath: "id" });
        an.createIndex("by_course", "courseId", { unique: false });
      }

      // video_chunks — keyPath: chunkId  e.g. "DCS311_W9_chunk_0"
      if (!db.objectStoreNames.contains("video_chunks")) {
        const vc = db.createObjectStore("video_chunks", { keyPath: "chunkId" });
        vc.createIndex("by_lecture", "lectureId", { unique: false });
      }

      // pdf_blobs — keyPath: lectureId
      if (!db.objectStoreNames.contains("pdf_blobs")) {
        db.createObjectStore("pdf_blobs", { keyPath: "lectureId" });
      }

      // download_metadata — keyPath: lectureId
      if (!db.objectStoreNames.contains("download_metadata")) {
        db.createObjectStore("download_metadata", { keyPath: "lectureId" });
      }

      // storage_usage — keyPath: id (always "current")
      if (!db.objectStoreNames.contains("storage_usage")) {
        db.createObjectStore("storage_usage", { keyPath: "id" });
      }

      // enrollments — keyPath: id  e.g. "studentId_courseId"
      if (!db.objectStoreNames.contains("enrollments")) {
        const en = db.createObjectStore("enrollments", { keyPath: "id" });
        en.createIndex("by_student", "student_id", { unique: false });
        en.createIndex("by_course",  "course_id",  { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// Singleton promise — one open DB for the whole page lifetime
let _dbPromise = null;
export function getDB() {
  if (!_dbPromise) _dbPromise = openDB();
  return _dbPromise;
}

// ─── Generic CRUD ─────────────────────────────────────────────────────────────

/** Read all records from a store */
export async function getAll(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Read one record by primary key */
export async function getById(storeName, id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/** Read all records matching an index value */
export async function getByIndex(storeName, indexName, value) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, "readonly");
    const index = tx.objectStore(storeName).index(indexName);
    const req   = index.getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Insert or overwrite a record (put = upsert) */
export async function put(storeName, record) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Delete a record by primary key */
export async function deleteById(storeName, id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/** Count records in a store */
export async function count(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Get all lectures for a specific course */
export async function getLecturesByCourse(courseId) {
  return getByIndex("lectures", "by_course", courseId);
}

/** Get all assignments for a specific course */
export async function getAssignmentsByCourse(courseId) {
  return getByIndex("assignments", "by_course", courseId);
}

/** Get download status for a lecture (null = not started) */
export async function getDownloadStatus(lectureId) {
  return getById("download_metadata", lectureId);
}

/** Check if a lecture's video is fully cached offline */
export async function isLectureOfflineReady(lectureId) {
  const meta = await getById("download_metadata", lectureId);
  return meta?.status === "complete";
}

/** Get all chunks stored for a lecture */
export async function getChunksByLecture(lectureId) {
  return getByIndex("video_chunks", "by_lecture", lectureId);
}

// ─── Seed Data ────────────────────────────────────────────────────────────────
// Hardcoded seed removed. Data now synced from Supabase via supabase.js.
// Call syncFromSupabase() or syncIfEmpty() from supabase.js on app load.
// ─── Seed Data ────────────────────────────────────────────────────────────────
// Hardcoded seed removed. Data now synced from Supabase via supabase.js.
// Call syncFromSupabase() from supabase.js on app load (after auth).
// Legacy stub kept so any old import of seedIfEmpty() doesn't crash.
export async function seedIfEmpty() {
  console.warn("[db] seedIfEmpty() is deprecated — use syncFromSupabase() from supabase.js instead.");
}