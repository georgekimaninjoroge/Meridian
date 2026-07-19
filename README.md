<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/meridian.png" alt="Meridian" width="100%"/>
</p>

## The Problem

Canvas, Moodle, Google Classroom all require a stable connection. The moment it drops, they stop working.

For students in Sub-Saharan Africa, Southeast Asia, rural India, and Latin America, that's not an edge case. It's the norm. A student in Nairobi on 3G mid-lecture loses their place. A student in Jakarta when campus WiFi cuts at 8pm loses the session.

Meridian flips the assumption: offline is the default. Network access is a bonus when available.

---

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/architecture.png" alt="Meridian architecture diagram"/>
</p>

Meridian is a local-first PWA. The UI never reads from the cloud. All reads go through IndexedDB as the on-device source of truth. Supabase handles sync only.

```
        NAIVE:
UI ─────────────────► Supabase

        MERIDIAN:
UI ─► IndexedDB ◄────► Supabase (sync only)
```

The app is fully functional from first load, regardless of network state. Supabase is consulted only when online, to pull updates and push progress.

---

## Offline Media Delivery

<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/offline-class.png" alt="Offline video playback" width="100%"/>
</p>

Video is the hardest piece of offline delivery. Meridian handles it without a custom server or encoding pipeline.

Supabase Storage supports HTTP Range requests natively. Meridian uses this to fetch lectures in sequential byte-range chunks, storing each as a binary blob in IndexedDB. A dropped connection mid-download resumes from the exact byte it stopped at. Once all chunks are present, playback runs entirely from local blobs, no network request, no buffering.

Teachers upload raw MP4. No encoding, no FFmpeg, no processing step.

---

## Smart Cache Orchestration

The Service Worker reads `navigator.connection.effectiveType` and caches accordingly:

| Connection | Behaviour |
|---|---|
| WiFi | Cache videos + notes automatically |
| 4G / 3G | Cache notes only, skip video to protect data budget |
| Offline | Serve fully from IndexedDB + Cache API |

No download button. Content is ready before the student needs it.

A storage guard tracks device quota in real time, warning at 80% and blocking video cache at 90%.

---

## Authentication Without a Server

On first login, Firebase Auth issues a JWT stored in IndexedDB alongside the user profile and role. When the student closes and reopens the app, the Local Session Manager reads the cached token and restores the session silently, online or offline.

Online: token refreshes in the background. Offline: the cached token is trusted as-is.

Logout is always explicit. Closing the app doesn't log you out.

---

## Cross-Device Progress Sync

Playback position writes to LocalStorage every 30 seconds during a lecture. When the device comes online, the Service Worker pushes it to Supabase. On login from another device, Supabase restores the exact position.

LocalStorage for speed. Supabase as cross-device truth.

---

## Live Classes

<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/live-class.png" alt="Live class session" width="100%"/>
</p>

Live sessions run on LiveKit. Token generation and room management are Supabase Edge Functions, the only server-side compute in the stack. Everything else is client-side.

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
