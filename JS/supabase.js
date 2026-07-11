/**
 * supabase.js — Meridian Supabase Client
 *
 * ARCHITECTURE ROLE:
 *   Fetches course data (courses, lectures, assignments, announcements)
 *   from Supabase Postgres and syncs into IndexedDB via db.js.
 *   UI always reads from IndexedDB — never directly from Supabase.
 *   Firebase Auth remains untouched.
 *
 * USAGE:
 *   import { syncFromSupabase } from "./supabase.js";
 *   await syncFromSupabase();   // call once on app load (replaces seedIfEmpty)
 */

import { put, count } from "./db.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://fzkpmptsnnkafaaeqhnf.supabase.co";
const SUPABASE_KEY = "sb_publishable_Sw15oAmzk8DDUiwOe8mU8A_g-ZHg5EO";

const HEADERS = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json"
};

// ─── Realtime client (separate from the REST fetch() calls above) ───────────
// Lazily created — only loaded when a page actually subscribes to changes,
// so pages that don't need Realtime (most of them) pay zero extra cost.
let _realtimeClientPromise = null;
async function getRealtimeClient() {
  if (!_realtimeClientPromise) {
    _realtimeClientPromise = import("https://esm.sh/@supabase/supabase-js@2")
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_KEY));
  }
  return _realtimeClientPromise;
}

/**
 * Subscribe to live changes on a table. Calls onChange(payload) for every
 * insert/update/delete. Returns an unsubscribe function — call it when the
 * page using this no longer needs updates (e.g. on navigation away).
 *
 * Usage:
 *   const unsub = await subscribeToTable("enrollments", (payload) => { ... });
 *   // later: unsub();
 */
export async function subscribeToTable(table, onChange) {
  const client = await getRealtimeClient();
  const channel = client
    .channel(`${table}-changes`)
    .on("postgres_changes", { event: "*", schema: "public", table }, onChange)
    .subscribe();
  return () => client.removeChannel(channel);
}

// ─── Generic fetch from any table ────────────────────────────────────────────
async function fetchTable(table) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?select=*`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`Supabase fetch failed [${table}]: ${res.status}`);
  return res.json();
}

// ─── Row mappers: Postgres snake_case → IndexedDB camelCase ──────────────────
function mapCourse(row) {
  return {
    id:       row.id,
    code:     row.code,
    title:    row.title,
    semester: row.semester,
    schedule: row.schedule,
    lecturer: row.lecturer,
    mode:     row.mode
  };
}

function mapLecture(row) {
  return {
    id:          row.id,
    courseId:    row.course_id,
    weekNumber:  row.week_number,
    title:       row.title,
    description: row.description,
    date:        row.date,
    scheduledFor: row.scheduled_for,
    live:        row.live,
    resources:   row.resources ?? [],
    videoUrl:    row.video_url,
    notesUrl:    row.notes_url
  };
}

function mapAssignment(row) {
  return {
    id:       row.id,
    courseId: row.course_id,
    type:     row.type,
    title:    row.title,
    due:      row.due
  };
}

function mapAnnouncement(row) {
  return {
    id:        row.id,
    courseId:  row.course_id,
    title:     row.title,
    body:      row.body,
    createdAt: row.created_at
  };
}

/**
 * Upload a file to the lecture-media storage bucket.
 * Returns the public-style path to store in video_url/notes_url.
 */
export async function uploadFile(file, courseId, weekNumber, kind) {
  const ext = file.name.split(".").pop();
  const path = `${courseId}/week${weekNumber}_${kind}.${ext}`;

  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/lecture-media/${path}`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": file.type || "application/octet-stream",
        "x-upsert": "true"
      },
      body: file
    }
  );
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);

  // Signed URL valid 1 year (bucket is private)
  const signRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/lecture-media/${path}`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ expiresIn: 31536000 })
    }
  );
  if (!signRes.ok) throw new Error(`Signing failed: ${signRes.status}`);
  const { signedURL } = await signRes.json();
  return `${SUPABASE_URL}/storage/v1${signedURL}`;
}

/**
 * Insert or update a lecture row (upsert by id).
 * row: { id, courseId, weekNumber, title, description, date, live, resources, videoUrl, notesUrl }
 */
export async function upsertLecture(row) {
  const payload = {
    id: row.id,
    course_id: row.courseId,
    week_number: row.weekNumber,
    title: row.title,
    description: row.description,
    date: row.date,
    scheduled_for: row.scheduledFor || null,
    live: !!row.live,
    resources: row.resources || [],
    video_url: row.videoUrl || null,
    notes_url: row.notesUrl || null
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/lectures`, {
    method: "POST",
    headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Lecture upsert failed: ${res.status} ${await res.text()}`);
  const [saved] = await res.json();

  await put("lectures", mapLecture({
    id: saved.id, course_id: saved.course_id, week_number: saved.week_number,
    title: saved.title, description: saved.description, date: saved.date,
    scheduled_for: saved.scheduled_for,
    live: saved.live, resources: saved.resources, video_url: saved.video_url, notes_url: saved.notes_url
  }));

  return saved;
}

/** Delete a lecture by id (Supabase + local IndexedDB). */
export async function deleteLecture(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/lectures?id=eq.${id}`, {
    method: "DELETE",
    headers: HEADERS
  });
  if (!res.ok) throw new Error(`Lecture delete failed: ${res.status}`);
  const { deleteById } = await import("./db.js");
  await deleteById("lectures", id);
}

/**
 * Insert or update an assignment row (upsert by id).
 * row: { id, courseId, type, title, due }
 */
export async function upsertAssignment(row) {
  const payload = {
    id: row.id,
    course_id: row.courseId,
    type: row.type,
    title: row.title,
    due: row.due
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/assignments`, {
    method: "POST",
    headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Assignment upsert failed: ${res.status} ${await res.text()}`);
  const [saved] = await res.json();

  await put("assignments", mapAssignment({
    id: saved.id, course_id: saved.course_id, type: saved.type, title: saved.title, due: saved.due
  }));

  return saved;
}

/** Delete an assignment by id (Supabase + local IndexedDB). */
export async function deleteAssignment(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/assignments?id=eq.${id}`, {
    method: "DELETE",
    headers: HEADERS
  });
  if (!res.ok) throw new Error(`Assignment delete failed: ${res.status}`);
  const { deleteById } = await import("./db.js");
  await deleteById("assignments", id);
}

// ─── Admin: Users ─────────────────────────────────────────────────────────────
export async function fetchUsers() {
  return fetchTable("users");
}

export async function upsertUser(u) {
  const payload = {
    id: u.id, portal_id: u.portalId, display_name: u.displayName,
    email: u.email, role: u.role, grade: u.grade || null, stream: u.stream || null
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json())[0];
}

// ─── Admin: Courses (create/delete) ──────────────────────────────────────────
export async function upsertCourse(c) {
  const payload = { id: c.id, code: c.code, title: c.title, semester: c.semester, schedule: c.schedule, lecturer: c.lecturer, mode: c.mode };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/courses`, {
    method: "POST",
    headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  const [saved] = await res.json();
  await put("courses", mapCourse(saved));
  return saved;
}

export async function deleteCourse(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/courses?id=eq.${id}`, { method: "DELETE", headers: HEADERS });
  if (!res.ok) throw new Error(await res.text());
  const { deleteById } = await import("./db.js");
  await deleteById("courses", id);
}

// ─── Admin: Course-Teacher assignment ────────────────────────────────────────
export async function fetchCourseTeachers() {
  return fetchTable("course_teachers");
}

export async function assignTeacher(courseId, teacherId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/course_teachers`, {
    method: "POST",
    headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ course_id: courseId, teacher_id: teacherId })
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function unassignTeacher(courseId, teacherId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/course_teachers?course_id=eq.${courseId}&teacher_id=eq.${teacherId}`, {
    method: "DELETE", headers: HEADERS
  });
  if (!res.ok) throw new Error(await res.text());
}

// ─── Admin: Enrollment ────────────────────────────────────────────────────────
export async function fetchEnrollments() {
  return fetchTable("enrollments");
}

export async function enrollStudent(studentId, courseId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/enrollments`, {
    method: "POST",
    headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ student_id: studentId, course_id: courseId })
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function unenrollStudent(studentId, courseId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/enrollments?student_id=eq.${studentId}&course_id=eq.${courseId}`, {
    method: "DELETE", headers: HEADERS
  });
  if (!res.ok) throw new Error(await res.text());
}

// Bulk auto-enroll: university style (portal ID prefix match e.g. "DCS")
export async function autoEnrollByPrefix(prefix, courseId) {
  const users = await fetchUsers();
  const matches = users.filter(u => u.role === "student" && (u.portal_id || "").toUpperCase().startsWith(prefix.toUpperCase()));
  for (const u of matches) await enrollStudent(u.id, courseId);
  return matches.length;
}

// Bulk auto-enroll: CBC style (grade + stream match)
export async function autoEnrollByGradeStream(grade, stream, courseId) {
  const users = await fetchUsers();
  const matches = users.filter(u => u.role === "student" && u.grade === grade && (!stream || u.stream === stream));
  for (const u of matches) await enrollStudent(u.id, courseId);
  return matches.length;
}

// ─── Main sync ───────────────────────────────────────────────────────────────
/**
 * Pulls all data from Supabase and writes into IndexedDB.
 * Full replace — always syncs latest from server.
 * Call once per session (after auth confirms online).
 */
export async function syncFromSupabase() {
  console.log("[supabase] Syncing from Supabase...");

  try {
    const [courses, lectures, assignments, announcements, enrollments] = await Promise.all([
      fetchTable("courses"),
      fetchTable("lectures"),
      fetchTable("assignments"),
      fetchTable("announcements"),
      fetchTable("enrollments")
    ]);

    for (const row of courses)       await put("courses",       mapCourse(row));
    for (const row of lectures)      await put("lectures",      mapLecture(row));
    for (const row of assignments)   await put("assignments",   mapAssignment(row));
    for (const row of announcements) await put("announcements", mapAnnouncement(row));
    for (const row of enrollments)   await put("enrollments",   { id: `${row.student_id}_${row.course_id}`, student_id: row.student_id, course_id: row.course_id });

    console.log(`[supabase] Sync complete — ${courses.length} courses, ${lectures.length} lectures, ${assignments.length} assignments, ${announcements.length} announcements, ${enrollments.length} enrollments.`);
    return true;
  } catch (err) {
    console.warn("[supabase] Sync failed — using cached IndexedDB data.", err);
    return false;
  }
}

/**
 * Sync only if IndexedDB is empty (first run fallback).
 * Prefer calling syncFromSupabase() directly for a full refresh.
 */
export async function syncIfEmpty() {
  const existing = await count("courses");
  if (existing > 0) {
    console.log("[supabase] IndexedDB already has data — skipping seed sync.");
    return;
  }
  await syncFromSupabase();
}