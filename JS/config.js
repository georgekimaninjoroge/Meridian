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
  if (_fullConfig) return _fullConfig;
  const cached = sessionStorage.getItem("meridian_config");
  if (cached) { _fullConfig = JSON.parse(cached); return _fullConfig; }
  const res = await fetch(CONFIG_ENDPOINT, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!res.ok) throw new Error(`get-config failed: ${res.status}`);
  const data  = await res.json();
  _fullConfig = { supabaseKey: data.supabaseKey, livekitWsUrl: data.livekitWsUrl, firebase: data.firebase };
  sessionStorage.setItem("meridian_config", JSON.stringify(_fullConfig));
  return _fullConfig;
}

export function clearConfig() {
  _firebaseConfig = null; _fullConfig = null;
  sessionStorage.removeItem("meridian_fb_config");
  sessionStorage.removeItem("meridian_config");
}
