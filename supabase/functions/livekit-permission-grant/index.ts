// supabase/functions/livekit-permission-grant/index.ts
//
// PURPOSE:
//   Teacher clicks "Allow" on a raised hand -> this flips that student's
//   canPublish to true (or back to false) on an already-running LiveKit room.
//   Replaces the old Express token-server.js /permission/grant route.
//
// CALL FROM FRONTEND:
//   POST https://<project>.supabase.co/functions/v1/livekit-permission-grant
//   body: { "roomName": "DCS311_live", "identity": "<uid>", "allow": true }
//   headers: { "Authorization": "Bearer <supabase anon key>" }

import { RoomServiceClient } from "https://esm.sh/livekit-server-sdk@2";

const LIVEKIT_URL        = Deno.env.get("LIVEKIT_URL")!;
const LIVEKIT_API_KEY    = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
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
    const { roomName, identity, allow } = await req.json();

    if (!roomName || !identity) {
      return new Response(
        JSON.stringify({ error: "roomName and identity are required" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

    await roomService.updateParticipant(roomName, identity, undefined, {
      canPublish: !!allow,
      canSubscribe: true,
      canPublishData: true,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[livekit-permission-grant] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
