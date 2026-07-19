<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/meridian.png" alt="Meridian" width="100%"/>
</p>

## The Problem

Canvas, Moodle, and Google Classroom share one fatal assumption: the network is always there. The moment it drops, they stop working. No fallback, no queue, no recovery.

For students in Sub-Saharan Africa, Southeast Asia, rural India, and Latin America, that's not an edge case. It's the norm. A student in Nairobi on 3G mid-lecture loses their place. A student in Jakarta when campus WiFi cuts at 8pm loses the session entirely.

Meridian flips the assumption. Offline is the default. Network access is a bonus when available.

---

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/architecture.png" alt="Meridian architecture diagram"/>
</p>

Every other LMS does this:

```
UI ──────────────────────► Cloud
     (breaks when offline)
```

Meridian does this:

```
UI ──► IndexedDB ◄──────── Supabase (sync only, when online)
           ▲
    source of truth
    on every read
```

The UI never reads from the cloud. All reads go through IndexedDB. Supabase is consulted only to pull updates and push progress when a connection exists. The app is fully functional from first load regardless of network state.

### Layers

| Layer | Role |
|---|---|
| **UI** | All reads from IndexedDB. Zero direct cloud reads |
| **IndexedDB** | On-device source of truth: courses, lectures, chunks, metadata, quota |
| **Service Worker** | Cache-first app shell, network-first data, offline fallback, virtual video filesystem |
| **Firebase Auth** | JWT issuance with `browserLocalPersistence` that survives browser close |
| **Supabase Postgres** | Course data, enrollments, assessments, progress sync |
| **Supabase Storage** | Chunked video and PDF blobs via HTTP Range requests |
| **Supabase Edge Functions** | Auth-gated media proxy, upload handler, LiveKit token and room management |
| **LiveKit** | Real-time video, audio, screen-share, and chat for live lectures |

---

## Offline Media Delivery

<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/offline-class.png" alt="Offline video playback" width="100%"/>
</p>

Video is the hardest piece of offline delivery. Meridian handles it without a custom server, transcoding pipeline, or CDN dependency.

### How chunked streaming works

Teachers upload raw MP4. No encoding, no FFmpeg, no processing step.

The upload client (`MediaUploader`) slices the file into **5 MB chunks** and POSTs each to the `media-upload` Edge Function with exponential backoff retry (3 attempts at 1s, 2s, 4s). Each chunk lands at `lecture-media/{assetId}/{00000}` in Supabase Storage and gets recorded in `storage_chunks`.

On playback, a **virtual video filesystem** in the Service Worker intercepts all `Range` requests to `/virtual-video/{assetId}`:

```
Plyr  >>>  GET /virtual-video/{assetId}  Range: bytes=0-1048575
SW    >>>  calculates which 5 MB chunks to fetch
SW    >>>  GET media-proxy?assetId=...&chunk=0  (Supabase Edge Fn)
SW    >>>  slices bytes, returns 206 Partial Content
Plyr  >>>  plays seamlessly, no buffering stall
```

The SW keeps an in-memory chunk cache (capped at 20 chunks, around 100 MB) and prefetches the next 2 chunks in the background as playback progresses. No blob assembly required, no full download before play starts.

### Resumable offline download

`MediaDownloader` fetches all chunks into IndexedDB (`video_chunks` store). Each chunk is a binary blob keyed by `{assetId}_{chunkIndex}`. A dropped connection mid-download resumes from the exact chunk it stopped at since download state persists in `download_metadata`. Once complete, playback assembles a local `Blob` URL and runs entirely without a network request.

---

## Smart Cache Orchestration

The Service Worker reads `navigator.connection.effectiveType` on each fetch and adapts:

| Connection | Behaviour |
|---|---|
| WiFi | Auto-cache video chunks and lecture notes |
| 4G / 3G | Cache notes only, skip video to protect data budget |
| Offline | Serve fully from IndexedDB and Cache API |

No download button. Content is ready before the student needs it.

### Storage quota guard

`StorageMonitor` polls `navigator.storage.estimate()` every 60 seconds and writes a snapshot to IndexedDB:

- **At 80%:** amber banner injected into the page; video caching pauses; PDFs and notes continue
- **At 90%:** red banner; all new video chunk writes are hard-blocked

On first run, `StorageMonitor` requests `navigator.storage.persist()`. If granted, the browser switches from the roughly 2 GB best-effort quota to a disk-based persistent quota. Silent, no UI prompt.

### Activity-weighted TTL eviction

`CacheJanitor` runs silently on every app open and evicts stale video chunks from IndexedDB:

| Rule | TTL |
|---|---|
| Base | 14 days since `lastAccessedAt` |
| App inactive 7+ days | TTL halved to 7 days |
| Course 100% complete | Fast-track to 7 days |
| Accessed within 48 hours | Never evict |

Priority order: oldest access first, then largest file size, then completed courses. `CacheJanitor.touch(lectureId)` resets the clock on every play event.

---

## Authentication Without a Server

On first login, Firebase Auth issues a JWT stored in IndexedDB alongside the user profile and role. Session restoration on reopen is instant with no network round-trip required.

`navigator.onLine` only checks whether the NIC is up, not whether packets actually reach the internet. It fails silently behind dead routers and captive portals. Meridian's `isReallyOnline()` does a real `HEAD` probe to the Supabase endpoint with an 800ms `AbortSignal.timeout` before trusting the "online" path.

```
Online:   Firebase token refreshes in the background every 50 min (tokens expire at 1h)
Offline:  Cached token trusted as-is; app fully functional
Logout:   Always explicit. Closing the tab never logs you out.
```

### Role-based access

Three roles: `student`, `teacher`, `admin`. Role is stored in Firestore and cached in IndexedDB. Every page checks role on load and redirects if mismatched. Edge Functions re-verify the Firebase JWT on every request so no server-side session is needed.

---

## Cross-Device Progress Sync

Playback position writes to `localStorage` every 30 seconds during a lecture. When the device comes online, the Service Worker pushes it to Supabase Postgres. Login from another device restores the exact position.

`localStorage` for speed. Supabase as cross-device truth.

PDF page position works the same way: stored locally, synced on reconnect.

---

## Live Classes

<p align="center">
  <img src="https://raw.githubusercontent.com/georgekimaninjoroge/Meridian/main/assets/live-class.png" alt="Live class session" width="100%"/>
</p>

Live sessions run on **LiveKit**. Token generation and room management are Supabase Edge Functions, the only server-side compute in the stack.

### Flow

```
Teacher clicks "Start Class"
  >>> livekit-start-room Edge Fn creates room and configures Auto Egress
  >>> LiveKit records session to Supabase Storage ({lectureId}_recording.mp4)
  >>> livekit-egress-webhook fires on room end and writes asset ID to lecture record
  >>> Recording immediately available as a standard chunked video lecture
```

Students join via `livekit-token` Edge Fn, which issues a scoped participant token after verifying enrollment. Features: video, audio, screen-share, real-time chat, all client-side via `livekit-client@2`.

The LiveKit JS client is lazily imported. Pages that don't use live classes pay zero cost.

---

## Assessments

Teachers create CATs, assignments, and quizzes per course. Assessment data lives in Supabase Postgres (`assessments`, `questions`, `attempts` tables) and syncs into IndexedDB on load. Students submit attempts client-side and results sync to Supabase when online.

---

## Realtime Sync

`supabase.js` exposes `subscribeToTable(table, onChange)`, a thin wrapper over the Supabase Realtime `postgres_changes` subscription. Used selectively for enrollment updates and live attendance. The Supabase JS client is lazily imported so only pages that subscribe to live changes load it.

---

## Storage Layout

| Store | Engine | Contents |
|---|---|---|
| `courses` / `lectures` | IndexedDB | Metadata, week structure |
| `assignments` / `announcements` | IndexedDB | Per-course content |
| `enrollments` | IndexedDB | Student to course mapping |
| `video_chunks` | IndexedDB | 5 MB binary blobs per chunk |
| `pdf_blobs` | IndexedDB | Full PDF binary |
| `download_metadata` | IndexedDB | Chunk progress, `lastAccessedAt`, `courseProgress` |
| `storage_usage` | IndexedDB | Quota snapshots every 60 seconds |
| `auth_sessions` | IndexedDB | JWT, user profile, role |
| `playback_progress` | LocalStorage | Position synced to Supabase on reconnect |
| App shell | Cache API | HTML, CSS, JS, fonts, icons |

---

## Edge Functions

| Function | Auth | Role |
|---|---|---|
| `get-config` | Optional Firebase JWT | Returns Firebase config publicly and Supabase anon key when authenticated |
| `media-upload` | Firebase JWT | Receives 5 MB chunks, writes to Supabase Storage and DB |
| `media-proxy` | Firebase JWT + enrollment check | Gates chunk access and streams bytes to SW |
| `livekit-token` | Firebase JWT | Issues scoped LiveKit participant token |
| `livekit-start-room` | Firebase JWT (teacher) | Creates room and configures Auto Egress recording |
| `livekit-egress-webhook` | LiveKit webhook secret | Writes finished recording asset ID to lecture record |
| `livekit-auto-start` | Internal | Scheduled room lifecycle management |

All functions verify Firebase JWTs manually. Supabase's built-in JWT check rejects Firebase tokens because they come from a different issuer.

---

## License

Apache 2.0 © [George Kimani Njoroge](https://github.com/georgekimaninjoroge)
