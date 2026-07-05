<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/meridian.png" alt="Meridian" width="100%"/>
</p>



## The Problem

Every major LMS — Canvas, Moodle, Google Classroom — assumes a stable internet connection. They are built for fiber. The moment connectivity drops, they stop working entirely.

For students in Sub-Saharan Africa, Southeast Asia, rural India, and Latin America, unstable connectivity is not an edge case. It is the default. A student in Nairobi on 3G mid-lecture loses everything. A student in Jakarta on campus WiFi that cuts out at 8pm loses everything.

Meridian is built on the opposite assumption: **offline is the primary state. Online is a bonus.**

---

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/architecture.png" alt="Meridian architecture diagram"/>
</p>

Meridian is a local-first PWA. The core architectural decision is that **the UI never reads directly from the cloud**. All data flows through IndexedDB as the on-device source of truth. Supabase is used exclusively for sync.

```
        WRONG:
UI ─────────────────► Supabase

        MERIDIAN:
UI ─► IndexedDB ◄────► Supabase (sync only)
```

This means the app is fully functional the moment it loads — regardless of network state. Supabase is consulted only when online, to pull updates and push progress. The student's experience is identical online or off.

---

## Offline Media Delivery

<p align="center">
  <img src="https://placehold.co/800x400?text=Offline+Video+Playback+Screenshot" alt="Offline video playback from cached blobs"/>
</p>

Video delivery is the hardest offline problem. Meridian solves it without a custom server or encoding pipeline.

Supabase Storage natively supports HTTP Range requests. Meridian exploits this: lectures are fetched in sequential byte-range chunks, each stored as a binary blob in IndexedDB. A download interrupted by a dropped connection picks up from the exact byte it stopped at. When all chunks are present, playback is served entirely from local blobs — no network request, no buffering.

Teachers upload raw MP4. No encoding. No FFmpeg. No waiting.

---

## Smart Cache Orchestration

The Service Worker monitors connection quality via `navigator.connection.effectiveType` and caches accordingly:

| Connection | Behaviour |
|---|---|
| WiFi | Cache videos + notes automatically |
| 4G / 3G | Cache notes only — skip video to protect data budget |
| Offline | Serve fully from IndexedDB + Cache API |

Caching is automatic. No download button. Content is ready before the student needs it.

A storage guard tracks device quota in real time — warning at 80%, blocking video cache at 90% to prevent the device from filling up.

---

## Authentication Without a Server

Session management is handled entirely on-device. On first login, Firebase Auth issues a JWT which is stored in IndexedDB alongside the user profile and role. When the student closes the tab and reopens the app — online or offline — the Local Session Manager reads the cached token and restores the session silently.

Online: token is refreshed silently in the background.
Offline: the cached token is trusted as-is.

The student is never logged out by closing the app. Logout is always explicit.

---

## Cross-Device Progress Sync

Playback position is written to LocalStorage every 30 seconds during a lecture. When the device comes online, the Service Worker pushes the progress to Supabase. On login from a different device, Supabase restores the exact position.

LocalStorage for speed. Supabase as cross-device source of truth.

---

## Live Classes

<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/live-class.png" alt="Live class session" width="100%"/>
</p>

Meridian includes live class sessions powered by LiveKit. Token generation and room management run as Supabase Edge Functions — the only server-side compute in the stack. Everything else is client-side.

---

## Storage Layout

| Store | Engine | Contents |
|---|---|---|
| `auth_sessions` | IndexedDB | JWT, user profile, role |
| `courses` / `lectures` | IndexedDB | Metadata |
| `lecture_chunks` | IndexedDB | Binary blobs per chunk |
| `chunk_metadata` | IndexedDB | Byte ranges, download state |
| `pdf_blobs` | IndexedDB | Full PDF binary |
| `storage_usage` | IndexedDB | Quota tracking |
| `playback_progress` | LocalStorage | Position → Supabase on sync |
| App shell | Cache API | HTML, CSS, JS, fonts, icons |

---

## License

Apache 2.0 © [George Kimani Njoroge](https://github.com/georgekimaninjoroge)