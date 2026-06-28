<div align="center">

<!-- LOGO: drop your logo image in /assets/logo.png and uncomment the line below -->
<!-- <img src="assets/logo.png" alt="Meridian" width="120" /> -->

# Meridian

### Lightweight, offline-first LMS. Zero framework. Runs anywhere.

Go live in one click. Every session records and schedules itself.
Course content works with no connection at all.

[![Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-1a341a?style=flat-square)](LICENSE)
[![Supabase](https://img.shields.io/badge/backend-Supabase-1a341a?style=flat-square)](#architecture)
[![LiveKit](https://img.shields.io/badge/realtime-LiveKit-1a341a?style=flat-square)](#architecture)
[![Kenya](https://img.shields.io/badge/built%20in-Kenya-1a341a?style=flat-square)](#)

</div>

---

## The Problem

Most live teaching in Kenya happens over [KENET's web conference
platform](https://conference.ke) — free, built on open-source
BigBlueButton, and genuinely the backbone of remote university teaching
during COVID, at one point serving hundreds of thousands of classes a
year. It's good infrastructure, built for what it's for.

What it isn't built for: going live the moment a teacher decides to,
without a registration and verification step first, and without an
institution in the loop. It also serves universities and research
institutions specifically — primary and secondary schools, the CBC
context this project grew out of, sit outside that network entirely.

Meridian's premise is simple: a live classroom should be something a
teacher starts the same way they'd start a phone call. Not a room
booking. Not a separate conferencing tool duct-taped to a course portal.
One action, and you're teaching.

---

## What It Actually Does

- **Go live in one click.** No room booking, no verification step,
  no separate app to open.
- **Mic always free; camera and screen-share need a one-tap approval.**
  A room of 40 students doesn't become 40 webcams by default.
- **Every session records itself** and becomes that week's lecture
  automatically — no manual upload step.
- **Schedule a class for later and it starts itself** at the right
  time, with no one needing to be online to flip it on.
- **Exactly one live lecture at a time, system-wide** — never an
  ambiguous "which room is the real one" moment for a student.
- **Course pages double as the archive** — synced lecture notes next
  to the recorded video, organized by week.

---

## Roadmap

What exists today is the core loop: go live, record, schedule, archive.
What's actively being worked on next:

- **Load balancing across LiveKit regions** as classroom count grows
  past a single SFU's comfortable ceiling.
- **A proper auth/permission layer at the edge function level**
  (sidecar-style), instead of trusting client-asserted roles.
- **Finer-grained recording controls** — per-segment, not just
  start-to-end.
- **A real admin layer** for school-level user and course management,
  separate from the teacher/student surfaces shown here.

---

## Architecture

```
+----------------+        +----------------------+        +----------------+
|    Browser     | -----> |   Supabase Edge       | -----> |    LiveKit     |
|  (live.html)   |        |   Functions            |        |    Cloud       |
+----------------+        +----------------------+        +----------------+
        |                            |                              |
        |                            |                              v
        |                  +----------------------+        +----------------+
        +----------------->|   Supabase Postgres   |        |    Egress      |
                            |   (courses, lectures,  |        |    Recording   |
                            |    enrollments)        |        |    -> Storage  |
                            +----------------------+        +----------------+
                                       ^
                                       | every minute
                            +----------------------+
                            |   pg_cron              |
                            |   auto-starts any       |
                            |   lecture scheduled       |
                            |   for today                |
                            +----------------------+
```

No standalone backend server, no Docker, no ops team. Token issuing,
permission grants, room creation, and the auto-start scheduler are
independent Supabase Edge Functions, each doing exactly one job, each
deployable on its own.

This isn't a monolith with feature flags — it's small, single-purpose
pieces that fail independently and deploy independently. A bug in the
permission-grant function can't take down room creation. A new feature
in the scheduler doesn't require redeploying the token service.

---

## Stack

| Layer            | Choice                | Why                                                              |
|-------------------|-----------------------|-------------------------------------------------------------------|
| Frontend          | Plain HTML / CSS / JS | No build step, no framework tax, runs anywhere a browser does     |
| Auth              | Firebase Auth         | Battle-tested session handling, survives offline/restart cleanly  |
| Realtime video    | LiveKit               | Open WebRTC infra — handles the hard SFU + recording problems     |
| Backend           | Supabase              | Postgres + Auth + Edge Functions + Realtime, no servers to run    |
| Scheduling        | `pg_cron` + `pg_net`  | Native Postgres cron, no external job queue needed                |
| Hosting           | Netlify               | Static deploy, zero config                                        |

---

## Project Structure

```
Meridian/
  index.html                 Student dashboard
  course.html                  Single-course view (lectures, notes, live status)
  live.html                     The live classroom — video, chat, controls
  media.html                     Recorded-lecture playback + synced PDF notes
  teacher.html                   Teacher dashboard
  teacher_course.html             Teacher's course + lecture management
  JS/
    livekit.js                    Room connect / token helpers
    supabase.js                     DB read/write + realtime subscriptions
    session.js                       Auth session handling
    cache-janitor.js                  Activity-weighted offline cache eviction
    storage-monitor.js                  Browser storage quota tracking + warnings
  supabase/functions/
    livekit-token/                   Issues join tokens, bakes in role
    livekit-permission-grant/         Approves a student's cam/share request
    livekit-start-room/                 Creates the room + starts auto-recording
    livekit-auto-start/                   Cron target — starts scheduled lectures
    livekit-egress-webhook/                Catches the finished recording, saves it
```

---

## The Hard Part: No Single Source of Truth

The genuinely difficult problem in a system like this isn't any one
feature — it's that "is this lecture live, and who's actually in it"
has to be agreed on by **three independent systems that can't directly
query each other in real time**:

```
LiveKit room state          Supabase `lectures.live` flag        Each browser's local JS state
(who's actually connected,  (what the database believes           (what this specific tab
 publishing, speaking —     right now — can be stale the           thinks is true, updated only
 lives in LiveKit's own     instant a teacher's connection          by events it has actually
 infra, not in Postgres)    drops without a clean disconnect)       received, in order, so far)
```

There's no central server polling all three and reconciling them — that
would mean running infrastructure, which defeats the point. Instead,
every piece of state changes by **event, not by query**: a participant
joining, a permission flipping, a track publishing. Each side reacts to
events as they arrive and converges toward the same picture — eventually,
not instantly.

That sounds fine until you hit the actual failure modes:

- A teacher ends a session, but a cron job a minute later doesn't know
  that "ended" should mean "don't restart this today" — so it has to
  encode *intent*, not just current state, to avoid fighting the teacher.
- Two lectures can both believe they're "the" live one for a few hundred
  milliseconds if two different triggers (a manual click and a cron tick)
  fire close together — the system needs an explicit invariant ("only one
  live lecture, ever") enforced at every entry point, not just checked once.
- A browser tab's local video grid can get into a state where it requires
  a subscription to know a track exists, but requires knowing a track
  exists to decide whether to subscribe — a dependency loop that has to
  be broken by changing *what triggers a render*, not by adding more checks.

None of these show up as one bug with one fix. They show up as a class
of bugs that all trace back to the same root cause, and the actual fix is
architectural: every place state can change has to assume every other
place might be wrong, briefly, and design for convergence rather than
correctness-on-first-try.

---

## Status

Actively built, pre-launch. This repo shows the architecture and a slice
of the implementation. The full teacher-facing course management and
database schema aren't included here.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

<div align="center">
Built solo, in Nairobi.
</div>
