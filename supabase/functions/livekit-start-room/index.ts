// supabase/functions/livekit-start-room/index.ts
//
// PURPOSE:
//   Called when a teacher clicks "Start Lecture". Creates (or reuses) a LiveKit
//   room and configures Auto Egress so the moment the room starts, recording
//   begins automatically, and the moment it ends, the finished MP4 is uploaded
//   directly into the Supabase "lecture-media" bucket via the S3-compatible API.
//
//   This function does NOT write the resulting video_url into the lectures
//   table — that happens in livekit-egress-webhook, fired by LiveKit once the
//   recording is actually finished and uploaded (we don't know the final file
//   path/duration until then).
//
// DEPLOY:
//   supabase functions deploy livekit-start-room
//   (uses the same LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL secrets
//    as livekit-token, plus these additional ones:)
//   supabase secrets set S3_ACCESS_KEY_ID=<from Storage Settings>
//   supabase secrets set S3_SECRET_ACCESS_KEY=<from Storage Settings>
//   supabase secrets set S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
//   supabase secrets set S3_REGION=<your project region, e.g. eu-west-1>
//
// CALL FROM FRONTEND (teacher_course.html "Start Lecture" button):
//   POST https://<project>.supabase.co/functions/v1/livekit-start-room
//   body: { "roomName": "DCS311_W9_live", "lectureId": "DCS311_W9" }

import { RoomServiceClient, EgressClient, EncodedFileType } from "https://esm.sh/livekit-server-sdk@2";

const LIVEKIT_URL        = Deno.env.get("LIVEKIT_URL")!;
const LIVEKIT_API_KEY    = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;

const S3_ACCESS_KEY = Deno.env.get("S3_ACCESS_KEY_ID")!;
const S3_SECRET_KEY = Deno.env.get("S3_SECRET_ACCESS_KEY")!;
const S3_ENDPOINT   = Deno.env.get("S3_ENDPOINT")!;
const S3_REGION     = Deno.env.get("S3_REGION") || "us-east-1";

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
    const { roomName, lectureId } = await req.json();
    if (!roomName || !lectureId) {
      return new Response(
        JSON.stringify({ error: "roomName and lectureId are required" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const egressClient = new EgressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

    // Create the room (no-op if it already exists — LiveKit rooms are
    // auto-created on first join anyway, but doing it explicitly here lets
    // us attach metadata that ties the room back to this lectureId).
    await roomService.createRoom({
      name: roomName,
      metadata: JSON.stringify({ lectureId }),
      emptyTimeout: 60 * 30, // auto-close 30 min after everyone leaves
    });

    // Filename inside the bucket: lecture-media/<courseId>/<lectureId>_recording.mp4
    // (matches the same path pattern uploadFile() in supabase.js already uses)
    const filepath = `${lectureId}_recording.mp4`;

    // Egress is best-effort — if recording fails (e.g. free-tier limit,
    // 50MB cap), the live class still proceeds. Warn in logs only.
    let egressId = null;
    try {
      const egressInfo = await egressClient.startRoomCompositeEgress(
        roomName,
        {
          file: {
            filepath,
            fileType: EncodedFileType.MP4,
            output: {
              case: "s3",
              value: {
                accessKey: S3_ACCESS_KEY,
                secret: S3_SECRET_KEY,
                bucket: "lecture-media",
                region: S3_REGION,
                endpoint: S3_ENDPOINT,
                forcePathStyle: true,
              },
            },
          },
        },
        { layout: "speaker" }
      );
      egressId = egressInfo.egressId;
    } catch (egressErr) {
      console.warn("[livekit-start-room] Egress failed (recording skipped):", String(egressErr));
    }

    return new Response(
      JSON.stringify({ roomName, egressId, filepath, recording: !!egressId }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[livekit-start-room] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});