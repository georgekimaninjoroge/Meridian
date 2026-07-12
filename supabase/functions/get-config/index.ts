// get-config — returns all client-side keys after Firebase JWT verification
// DEPLOY: supabase functions deploy get-config --no-verify-jwt

const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID")!;
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function verifyFirebaseToken(token: string): Promise<boolean> {
  try {
    const keys = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com").then(r => r.json());
    const [headerB64, payloadB64, sigB64] = token.split(".");
    const header = JSON.parse(atob(headerB64.replace(/-/g,"+").replace(/_/g,"/")));
    const pem    = keys[header.kid]?.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\n/g,"");
    if (!pem) return false;
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(atob(pem), c=>c.charCodeAt(0)), {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
      Uint8Array.from(atob(sigB64.replace(/-/g,"+").replace(/_/g,"/")), c=>c.charCodeAt(0)),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    if (!valid) return false;
    const p = JSON.parse(atob(payloadB64.replace(/-/g,"+").replace(/_/g,"/")));
    const now = Math.floor(Date.now()/1000);
    return p.exp > now && p.aud === FIREBASE_PROJECT_ID && p.iss === `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
  } catch { return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const token  = req.headers.get("Authorization")?.replace("Bearer ","").trim();
  const authed = token ? await verifyFirebaseToken(token) : false;

  const config: Record<string,unknown> = {
    firebase: {
      apiKey:            Deno.env.get("FIREBASE_API_KEY"),
      authDomain:        Deno.env.get("FIREBASE_AUTH_DOMAIN"),
      projectId:         Deno.env.get("FIREBASE_PROJECT_ID"),
      storageBucket:     Deno.env.get("FIREBASE_STORAGE_BUCKET"),
      messagingSenderId: Deno.env.get("FIREBASE_MESSAGING_SENDER_ID"),
      appId:             Deno.env.get("FIREBASE_APP_ID"),
    }
  };

  if (authed) {
    config.supabaseKey  = Deno.env.get("SUPABASE_ANON_KEY");
    config.livekitWsUrl = Deno.env.get("LIVEKIT_WS_URL");
  }

  return new Response(JSON.stringify(config), { headers: {...CORS, "Content-Type":"application/json"} });
});
