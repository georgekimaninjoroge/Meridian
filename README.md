<div align="center">

<!-- LOGO: drop your logo image in /assets/logo.png and uncomment the line below -->
<!-- <img src="assets/logo.png" alt="Meridian" width="120" /> -->

# Meridian

### A lightweight, offline-first LMS with live classrooms built in — not bolted on.

No framework, no custom server, no separate conferencing tool duct-taped
to a course portal. Go live in one click. Every session records and
schedules itself. Course content works with no connection at all.

[![Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-1a341a?style=flat-square)](LICENSE)
[![Supabase](https://img.shields.io/badge/backend-Supabase-1a341a?style=flat-square)](#architecture)
[![LiveKit](https://img.shields.io/badge/realtime-LiveKit-1a341a?style=flat-square)](#architecture)
[![Kenya](https://img.shields.io/badge/built%20in-Kenya-1a341a?style=flat-square)](#)

</div>

---

## The Problem

The institutions that do have a live-classroom system in Kenya are
mostly running [KENET's web conference platform](https://conference.ke)
— free, built on open-source BigBlueButton, and the backbone of remote
teaching for Kenyan universities during COVID, at one point serving
hundreds of thousands of classes a year.

It works. It also has a structural ceiling:

- **Going live requires institutional approval first.** To create a
  meeting room at all, a user has to register, and their identity has
  to be verified by KENET *together with the institution's ICT
  director* — before a teacher can ever open a room. There is no path
  from "I want to teach right now" to actually teaching that doesn't
  route through an administrative gatekeeper.
- **It serves universities, not schools.** Membership is restricted to
  universities, research institutes, and technical colleges. Primary
  and secondary schools — the CBC system this project originally grew
  out of — aren't part of this network at all. For that segment, the
  honest answer today is closer to "WhatsApp groups and hope."
- **A meeting room is not a course.** It has no concept of a syllabus,
  a week, a recording that becomes that week's lecture automatically,
  or a student dashboard that shows what's live right now. It's a
  conferencing tool bolted onto whatever LMS the institution already
  runs — usually Moodle, with its own separate maintenance burden.

The handful of fully commercial systems sold into Kenyan schools sit on
the other end: long procurement cycles, fixed annual maintenance
contracts regardless of how much the software is actually used, and a
release cycle measured in quarters because the vendor has no competitive
pressure once the contract is signed.

Meridian's premise: a live classroom should be something a teacher starts
the same way they'd start a phone call — not something that requires a
room booking, a verification step, or a separate piece of conferencing
software duct-taped to a course portal.

---

## What It Actually Does — and Where It Differs

|                      | KENET / institutional systems                          | Commercial vendor systems                         | Meridian                                                        |
|----------------------|----------------------------------------------------------|----------------------------------------------------|------------------------------------------------------------------|
| Starting a class      | Requires prior registration + ICT-director verification  | Manual, vendor-trained staff usually involved      | One click — "Start Class Now," live in seconds                  |
| Who it serves          | Universities & research institutions only                  | Whoever signs the contract                          | Built from the CBC/school context outward                       |
| Recording               | Manual moderator action, separate from the course itself     | Varies, often a separate module                      | Automatic — every live session becomes that week's lecture       |
| Scheduling               | No native course/week concept                                  | Usually exists, slow to change                        | Schedule once — the room opens itself, no one has to be present  |
| Camera/mic at scale       | Unmanaged — moderator must mute/manage manually                  | Varies by vendor                                       | Mic always free; camera/share need a one-tap approval             |
| Maintenance model          | Free, but fixed to whatever KENET ships and prioritizes             | Fixed annual contract, independent of actual usage       | Iterates continuously — a fix ships the day it's found, not the day a vendor schedules it |

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

