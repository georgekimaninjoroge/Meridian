/**
 * livekit.js — Meridian Live Lecture Client
 *
 * ARCHITECTURE ROLE:
 *   Talks to LiveKit Cloud for live video/audio/screen-share/chat during a
 *   lecture. Never holds the LIVEKIT_API_SECRET — that stays server-side in
 *   Supabase Edge Functions (livekit-token, livekit-start-room). This module
 *   only ever receives short-lived join tokens, never raw credentials.
 *
 *   Recording is handled entirely by LiveKit Egress (configured server-side
 *   in livekit-start-room) — this module does NOT manage recording directly.
 *   When the room ends, livekit-egress-webhook writes the finished video's
 *   URL into the lecture's video_url field automatically.
 *
 * USAGE:
 *   import { startLecture, joinLecture } from "./JS/livekit.js";
 *
 *   // Teacher clicks "Start Lecture":
 *   const room = await startLecture(lectureId, courseId, teacherUid, teacherName);
 *
 *   // Student clicks "Join Live Class":
 *   const room = await joinLecture(lectureId, studentUid, studentName, "student");
 */

const SUPABASE_URL = "https://fzkpmptsnnkafaaeqhnf.supabase.co";
const SUPABASE_KEY = "sb_publishable_Sw15oAmzk8DDUiwOe8mU8A_g-ZHg5EO";
const LIVEKIT_WS_URL = "wss://meridian-digital-learning-evlzr1xl.livekit.cloud";

let _Room, _RoomEvent, _Track, _connectModule;
async function loadLiveKitClient() {
  if (_Room) return;
  const mod = await import("https://esm.sh/livekit-client@2");
  _Room = mod.Room;
  _RoomEvent = mod.RoomEvent;
  _Track = mod.Track;
}

async function callEdgeFunction(name, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "apikey": SUPABASE_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge function ${name} failed [${res.status}]: ${text}`);
  }
  return res.json();
}

/**
 * Fetches a join token from the server (secret never touches the browser),
 * then connects to the LiveKit room. Returns the connected Room instance.
 */
async function connectToRoom(roomName, identity, name, role) {
  await loadLiveKitClient();
  const { token } = await callEdgeFunction("livekit-token", {
    roomName, identity, name, role,
  });

  const room = new _Room({
    adaptiveStream: true,  // auto-adjusts video quality to bandwidth
    dynacast: true,        // saves upload bandwidth when no one's watching a track
  });

  await room.connect(LIVEKIT_WS_URL, token);
  return room;
}

/**
 * Teacher action: starts the live room AND configures server-side Auto
 * Egress (recording -> Supabase Storage) in one call, then joins it.
 *
 * roomName convention: "<lectureId>_live" — keeps it unique and traceable
 * back to the lecture record, matching the filepath pattern the webhook
 * expects ("<lectureId>_recording.mp4").
 */
export async function startLecture(lectureId, teacherUid, teacherName) {
  const roomName = `${lectureId}_live`;

  // Server-side: create room + configure Auto Egress to Supabase Storage
  await callEdgeFunction("livekit-start-room", { roomName, lectureId });

  // Client-side: actually join as the teacher (full publish rights)
  const room = await connectToRoom(roomName, teacherUid, teacherName, "teacher");
  return room;
}

/**
 * Student/teacher action: joins an already-started live room.
 * If the room hasn't been started yet, the join will simply wait in an
 * empty room — calling code should check the lecture's `live` flag first
 * to decide whether to show "Join Live Class" at all.
 */
export async function joinLecture(lectureId, uid, name, role = "student") {
  const roomName = `${lectureId}_live`;
  const room = await connectToRoom(roomName, uid, name, role);
  return room;
}

/** Cleanly leaves a room — call this when navigating away from the lecture page. */
export async function leaveLecture(room) {
  if (room) await room.disconnect();
}

// Re-export so calling code can attach event listeners / track helpers
// without needing its own separate import of livekit-client.
export async function getLiveKitTrackHelpers() {
  await loadLiveKitClient();
  return { RoomEvent: _RoomEvent, Track: _Track };
}
