/**
 * config.js — Meridian Client Config
 * Only SUPABASE_URL is hardcoded — it is a public endpoint, not a secret.
 * Everything else is fetched from the get-config edge function.
 */
export const SUPABASE_URL = "https://fzkpmptsnnkafaaeqhnf.supabase.co";
const CONFIG_ENDPOINT     = `${SUPABASE_URL}/functions/v1/get-config`;

let _firebaseConfig = null;
let _fullConfig     = null;

export async function getFirebaseConfig() {
  if (_firebaseConfig) return _firebaseConfig;
  const cached = sessionStorage.getItem("meridian_fb_config");
  if (cached) { _firebaseConfig = JSON.parse(cached); return _firebaseConfig; }
  const res = await fetch(CONFIG_ENDPOINT);
  if (!res.ok) throw new Error(`get-config failed: ${res.status}`);
  const data      = await res.json();
  _firebaseConfig = data.firebase;
  sessionStorage.setItem("meridian_fb_config", JSON.stringify(_firebaseConfig));
  return _firebaseConfig;
}

export async function getConfig(idToken) {
  // Return cached only if it has the supabaseKey (i.e. was fetched authenticated)
  if (_fullConfig?.supabaseKey) return _fullConfig;
  const cached = sessionStorage.getItem("meridian_config");
  if (cached) {
    const parsed = JSON.parse(cached);
    if (parsed.supabaseKey) { _fullConfig = parsed; return _fullConfig; }
  }
  if (!idToken) throw new Error("idToken required for getConfig");
  const res = await fetch(CONFIG_ENDPOINT, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!res.ok) throw new Error(`get-config failed: ${res.status}`);
  const data  = await res.json();
  if (!data.supabaseKey) throw new Error("get-config returned no supabaseKey — token may be invalid");
  _fullConfig = { supabaseKey: data.supabaseKey, livekitWsUrl: data.livekitWsUrl, firebase: data.firebase };
  sessionStorage.setItem("meridian_config", JSON.stringify(_fullConfig));
  return _fullConfig;
}

export function clearConfig() {
  _firebaseConfig = null; _fullConfig = null;
  sessionStorage.removeItem("meridian_fb_config");
  sessionStorage.removeItem("meridian_config");
}