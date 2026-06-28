// supabase/functions/livekit-egress-webhook/index.ts
//
// PURPOSE:
//   LiveKit calls this URL automatically when an Egress (recording) job
//   finishes. We read the room's metadata (set in livekit-start-room) to
//   find which lectureId this recording belongs to, build the public/signed
//   URL for the uploaded file, and write it into that lecture's video_url
//   column — the same field manual uploads from teacher_course.html use.
//
//   After this runs, the recording is indistinguishable from a manually
//   uploaded video anywhere else in the app (media.html, course.html, etc).
//
// DEPLOY:
//   supabase functions deploy livekit-egress-webhook --no-verify-jwt
//   (--no-verify-jwt because LiveKit calls this directly, not through our
//    own authenticated frontend — it has its own webhook signature instead)
//
// CONFIGURE IN LIVEKIT:
//   LiveKit Cloud dashboard -> Settings -> Webhooks -> add this function's
//   URL: https://<project>.supabase.co/functions/v1/livekit-egress-webhook

import { WebhookReceiver } from "https://esm.sh/livekit-server-sdk@2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LIVEKIT_API_KEY    = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;
const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SECRET    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // needed to bypass anon limits when writing

const receiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

Deno.serve(async (req) => {
  try {
    const body = await req.text();
    const authHeader = req.headers.get("Authorization") || "";

    // Verifies this request genuinely came from LiveKit (signature check),
    // not a forged request trying to overwrite arbitrary lecture videos.
    const event = await receiver.receive(body, authHeader);

    if (event.event !== "egress_ended") {
      // We only care about the finished-recording event; ignore the rest
      // (egress_started, egress_updated, etc.)
      return new Response("ok", { status: 200 });
    }

    const egressInfo = event.egressInfo;
    if (!egressInfo || egressInfo.status !== "EGRESS_COMPLETE") {
      console.warn("[livekit-egress-webhook] Egress did not complete successfully:", egressInfo?.status);
      return new Response("ok", { status: 200 }); // ack anyway, nothing to write
    }

    // Pull lectureId back out of room metadata (set in livekit-start-room)
    const roomMetadata = JSON.parse(egressInfo.roomName ? "{}" : "{}"); // placeholder if roomName-only
    let lectureId: string | null = null;
    try {
      // egressInfo includes room info in some payload shapes; fall back to
      // parsing the file path we set ourselves in livekit-start-room
      // (filepath = "<lectureId>_recording.mp4")
      const fileResult = egressInfo.fileResults?.[0];
      const filename = fileResult?.filename || "";
      const match = filename.match(/^(.+)_recording\.mp4$/);
      lectureId = match ? match[1] : null;
    } catch (err) {
      console.warn("[livekit-egress-webhook] Could not parse lectureId from filename:", err);
    }

    if (!lectureId) {
      console.error("[livekit-egress-webhook] No lectureId found — cannot update lecture record.");
      return new Response("ok", { status: 200 }); // ack so LiveKit doesn't retry forever
    }

    // Build a signed URL for the uploaded file (same pattern as uploadFile()
    // in JS/supabase.js — 1 year expiry, since the bucket is private).
    const filepath = egressInfo.fileResults?.[0]?.filename;
    const { data: signedData, error: signError } = await supabase.storage
      .from("lecture-media")
      .createSignedUrl(filepath, 60 * 60 * 24 * 365);

    if (signError || !signedData) {
      console.error("[livekit-egress-webhook] Failed to sign URL:", signError);
      return new Response("ok", { status: 200 });
    }

    const { error: updateError } = await supabase
      .from("lectures")
      .update({ video_url: signedData.signedUrl, live: false })
      .eq("id", lectureId);

    if (updateError) {
      console.error("[livekit-egress-webhook] Failed to update lecture:", updateError);
    } else {
      console.log(`[livekit-egress-webhook] Lecture ${lectureId} updated with recording URL.`);
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("[livekit-egress-webhook] Error:", err);
    return new Response(String(err), { status: 500 });
  }
});
