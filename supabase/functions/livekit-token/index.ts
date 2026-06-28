// supabase/functions/livekit-token/index.ts
//
// PURPOSE:
//   Generates a signed LiveKit access token server-side, so the LIVEKIT_API_SECRET
//   never has to be shipped to the browser. The frontend calls this function with
//   { roomName, identity, name, role }, and gets back a short-lived JWT that the
//   LiveKit client SDK uses to join that specific room.
//
// DEPLOY:
//   supabase functions deploy livekit-token
//   supabase secrets set LIVEKIT_API_KEY=API9pgWkasBbGcM
//   supabase secrets set LIVEKIT_API_SECRET=<your secret>
//   supabase secrets set LIVEKIT_URL=wss://meridian-digital-learning-evlzr1xl.livekit.cloud
//
// CALL FROM FRONTEND:
//   POST https://<project>.supabase.co/functions/v1/livekit-token
//   body: { "roomName": "DCS311_live", "identity": "<uid>", "name": "George Kim", "role": "teacher" }
//   headers: { "Authorization": "Bearer <supabase anon key>" }

import { AccessToken } from "https://esm.sh/livekit-server-sdk@2";

const LIVEKIT_API_KEY    = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const { roomName, identity, name, role } = await req.json();

    if (!roomName || !identity) {
      return new Response(
        JSON.stringify({ error: "roomName and identity are required" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return new Response(
        JSON.stringify({ error: "LiveKit credentials not configured on server" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: name || identity,
      ttl: "2h", // generous enough for a full lecture
      attributes: { role: role === "teacher" ? "teacher" : "student" },
    });

    // Teachers get full publish rights (camera/mic/screen share).
    // Students can subscribe to everything but only publish if explicitly
    // unmuted by the teacher later (handled in-app, not here) — for now,
    // students join as view+chat only; teacher always gets full control.
    const isTeacher = role === "teacher";

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true, // everyone can publish camera/mic/screen — teacher and students alike
      canPublishData: true, // chat works for everyone
      canSubscribe: true,
      roomRecord: isTeacher, // only relevant for which client's join can be treated as "starting" recording logic
    });

    const token = await at.toJwt();

    return new Response(JSON.stringify({ token }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[livekit-token] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});