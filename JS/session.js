/**
 * session.js — Meridian Local Session Manager
 *
 * HOW IT WORKS:
 *   1. Firebase keeps the auth token alive via browserLocalPersistence (survives PC off).
 *   2. We also cache the user profile in localStorage so pages can read role/name
 *      instantly without a Firestore round-trip.
 *   3. OFFLINE FAST PATH: if offline + cache exists, skip Firebase entirely — instant load.
 *   4. onAuthStateChanged is the source of truth when online.
 *   5. When online, we silently refresh the cached profile from Firestore once per session.
 *   6. Logout clears BOTH Firebase session AND localStorage cache.
 *
 * CONNECTIVITY NOTE:
 *   navigator.onLine only detects whether the network interface is up — NOT whether
 *   packets actually reach the internet (fails silently behind dead routers / captive
 *   portals). We use isReallyOnline() which does a real HEAD probe to Firebase before
 *   trusting the "online" path.
 *
 * USAGE:
 *   import { requireSession, getSession, logout } from "./session.js";
 *   const session = await requireSession();
 *   // session = { uid, role, displayName, portalId, email }
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── Firebase config ─────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCXjaD4yArHvjzv1MtUbkmRUxcsFGg26fA",
  authDomain: "meridian-university-3b199.firebaseapp.com",
  projectId: "meridian-university-3b199",
  storageBucket: "meridian-university-3b199.firebasestorage.app",
  messagingSenderId: "179714904881",
  appId: "1:179714904881:web:f6fed2c0c99fc54a479610"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Survive PC restart, browser close, everything
await setPersistence(auth, browserLocalPersistence);

const SESSION_KEY = "meridian_session";
const REFRESH_MS  = 30 * 60 * 1000; // re-fetch Firestore profile every 30 min when online

// Guard: once resolved, ignore further onAuthStateChanged fires
let _resolved = false;

// ─── Real connectivity probe ──────────────────────────────────────────────────
// navigator.onLine = true only means the NIC is up, NOT that packets reach internet.
// This HEAD probe confirms actual Firebase reachability within 3 s.
async function isReallyOnline() {
  if (!navigator.onLine) return false; // NIC down = definitely offline, skip probe
  try {
    await fetch("https://firestore.googleapis.com/", {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(3000)
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Read cache ───────────────────────────────────────────────────────────────
export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ─── Write cache ──────────────────────────────────────────────────────────────
function saveSession(uid, profile) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    uid,
    role:        profile.role        || "",
    displayName: profile.displayName || profile.name || profile.email?.split("@")[0] || profile.portalId || "",
    portalId:    profile.portalId    || "",
    email:       profile.email       || "",
    cachedAt:    Date.now()
  }));
}

// ─── Clear cache ──────────────────────────────────────────────────────────────
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ─── Silent Firestore refresh (background, when online + stale) ───────────────
async function maybeFreshRefresh(uid) {
  const cached = getSession();
  const stale  = !cached || (Date.now() - (cached.cachedAt || 0)) > REFRESH_MS;
  if (!stale) return;
  if (!(await isReallyOnline())) return; // real probe, not just NIC check
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) saveSession(uid, snap.data());
  } catch { /* network blip — keep cache */ }
}

// ─── requireSession ───────────────────────────────────────────────────────────
// Returns Promise<session> or redirects to auth.html.
export async function requireSession() {

  // ── OFFLINE FAST PATH ──────────────────────────────────────────────────────
  // Real connectivity probe — catches dead routers, captive portals, etc.
  const online = await isReallyOnline();

  if (!online) {
    const cached = getSession();
    if (cached && cached.uid) {
      _resolved = true;
      return cached;
    }
    // Offline + no cache = nothing we can do, send to auth (will show network error)
    window.location.href = "auth.html";
    return new Promise(() => {}); // never resolves — redirect takes over
  }

  // ── ONLINE PATH — let Firebase confirm the token ───────────────────────────
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (_resolved) return; // guard against re-fires

      if (!user) {
        // Online, no Firebase session — real logout state
        // But check: Firebase sometimes fires null briefly on flaky connections
        const stillOnline = await isReallyOnline();
        const cached = getSession();
        if (cached && cached.uid && !stillOnline) {
          // Went offline mid-check — trust cache
          _resolved = true;
          resolve(cached);
          return;
        }
        clearSession();
        _resolved = true;
        window.location.href = "auth.html";
        return;
      }

      // Firebase confirmed user — ensure localStorage cache exists
      let cached = getSession();
      if (!cached || cached.uid !== user.uid) {
        try {
          const snap = await getDoc(doc(db, "users", user.uid));
          if (!snap.exists()) {
            await signOut(auth);
            clearSession();
            _resolved = true;
            window.location.href = "auth.html";
            return;
          }
          saveSession(user.uid, snap.data());
          cached = getSession();
        } catch {
          // Firestore unreachable — if we have a matching cache, trust it
          const fallback = getSession();
          if (fallback && fallback.uid === user.uid) {
            _resolved = true;
            resolve(fallback);
            return;
          }
          // No cache at all — can't continue
          clearSession();
          _resolved = true;
          window.location.href = "auth.html";
          return;
        }
      }

      // Cache good — silently refresh in background if stale
      maybeFreshRefresh(user.uid);

      _resolved = true;
      resolve(cached);
    });
  });
}

// ─── logout ───────────────────────────────────────────────────────────────────
export async function logout() {
  _resolved = false;
  try { await signOut(auth); } catch { /* ignore */ }
  clearSession();
  window.location.href = "auth.html";
}