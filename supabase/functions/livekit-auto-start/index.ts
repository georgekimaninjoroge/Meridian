// supabase/functions/livekit-auto-start/index.ts
//
// PURPOSE:
//   Called by pg_cron every minute. Finds any lecture scheduled for today
//   that isn't live yet, starts its LiveKit room + Egress (same as
//   livekit-start-room), and flips live:true — so students can join even
//   if the teacher hasn't opened the app yet.
//
// DEPLOY:
//   supabase functions deploy livekit-auto-start --no-verify-jwt
//   (--no-verify-jwt because pg_cron calls this with the service role key,
//    not a user session)
//
// SCHEDULE (run once in Supabase SQL editor):
//   select cron.schedule(
//     'auto-start-scheduled-lectures',
//     '* * * * *',  -- every minute
//     $$
//     select net.http_post(
//       url := 'https://<project-ref>.supabase.co/functions/v1/livekit-auto-start',
//       headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
//     );
//     $$
//   );
//   (requires the pg_cron and pg_net extensions enabled — Database -> Extensions)

import { RoomServiceClient, EgressClient, EncodedFileType } from "https://esm.sh/livekit-server-sdk@2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LIVEKIT_URL        = Deno.env.get("LIVEKIT_URL")!;
const LIVEKIT_API_KEY    = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;
const S3_ACCESS_KEY = Deno.env.get("S3_ACCESS_KEY_ID")!;
const S3_SECRET_KEY = Deno.env.get("S3_SECRET_ACCESS_KEY")!;
const S3_ENDPOINT   = Deno.env.get("S3_ENDPOINT")!;
const S3_REGION     = Deno.env.get("S3_REGION") || "us-east-1";

const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);
    const todayISO = new Date().toISOString().slice(0, 10);

    const { data: dueLectures, error } = await supabase
      .from("lectures")
      .select("id")
      .eq("scheduled_for", todayISO)
      .eq("live", false)
      .is("auto_started_at", null);

    if (error) throw error;
    if (!dueLectures?.length) {
      return new Response(JSON.stringify({ started: 0 }), { status: 200 });
    }

    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const egressClient = new EgressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    let started = 0;

    for (const lecture of dueLectures) {
      const lectureId = lecture.id;
      const roomName = `${lectureId}_live`;
      try {
        // Keep the one-live-lecture-at-a-time invariant: end whatever else
        // is currently live before this one takes over.
        await supabase.from("lectures").update({ live: false }).eq("live", true);
        await roomService.createRoom({
          name: roomName,
          metadata: JSON.stringify({ lectureId }),
          emptyTimeout: 60 * 30,
        });

        try {
          await egressClient.startRoomCompositeEgress(
            roomName,
            {
              file: {
                filepath: `${lectureId}_recording.mp4`,
                fileType: EncodedFileType.MP4,
                output: {
                  case: "s3",
                  value: {
                    accessKey: S3_ACCESS_KEY, secret: S3_SECRET_KEY,
                    bucket: "lecture-media", region: S3_REGION,
                    endpoint: S3_ENDPOINT, forcePathStyle: true,
                  },
                },
              },
            },
            { layout: "speaker" }
          );
        } catch (egressErr) {
          console.warn(`[livekit-auto-start] Egress failed for ${lectureId}:`, String(egressErr));
        }

        await supabase.from("lectures").update({ live: true, auto_started_at: new Date().toISOString() }).eq("id", lectureId);
        started++;
      } catch (err) {
        console.error(`[livekit-auto-start] Failed to start ${lectureId}:`, err);
      }
    }

    return new Response(JSON.stringify({ started }), { status: 200 });
  } catch (err) {
    console.error("[livekit-auto-start] Error:", err);
    return new Response(String(err), { status: 500 });
  }
});