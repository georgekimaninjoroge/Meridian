// supabase/functions/livekit-egress-webhook/index.ts
//
// When LiveKit Egress finishes recording, this webhook:
//   1. Downloads the recorded MP4 from LiveKit's S3 egress output
//   2. Chunks it (5MB) and uploads each chunk to GitHub bucket via media-upload
//   3. Writes the assetId into lectures.video_url so the rest of the app
//      fetches it through media-proxy (auth-gated, range-request capable)
//
// DEPLOY:
//   supabase functions deploy livekit-egress-webhook --no-verify-jwt

import { WebhookReceiver } from "https://esm.sh/livekit-server-sdk@2";
import { createClient }    from "https://esm.sh/@supabase/supabase-js@2";

const LIVEKIT_API_KEY    = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;
const SB_URL             = Deno.env.get("SUPABASE_URL")!;
const SB_KEY             = Deno.env.get("SB_SERVICE_KEY")!;
const GITHUB_PAT         = Deno.env.get("GITHUB_PAT")!;
const GITHUB_OWNER       = Deno.env.get("GITHUB_OWNER")!;
const GITHUB_REPO        = Deno.env.get("GITHUB_BUCKET_REPO")!;

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const GH_API     = "https://api.github.com";
const ghHeaders  = {
  Authorization: `Bearer ${GITHUB_PAT}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const receiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const supabase = createClient(SB_URL, SB_KEY);

// ── GitHub helpers ────────────────────────────────────────────────────────────
async function ensureRelease(tag: string): Promise<number> {
  const get = await fetch(`${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${tag}`, { headers: ghHeaders });
  if (get.ok) return (await get.json()).id;
  const create = await fetch(`${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`, {
    method: "POST",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }),
  });
  if (!create.ok) throw new Error(`Create release failed: ${await create.text()}`);
  return (await create.json()).id;
}

async function uploadChunk(releaseId: number, filename: string, bytes: Uint8Array): Promise<string> {
  const url = `https://uploads.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(filename)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...ghHeaders, "Content-Type": "video/mp4" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Chunk upload failed: ${await res.text()}`);
  return (await res.json()).browser_download_url;
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  try {
    const body       = await req.text();
    const authHeader = req.headers.get("Authorization") || "";
    const event      = await receiver.receive(body, authHeader);

    if (event.event !== "egress_ended") return new Response("ok", { status: 200 });

    const egressInfo = event.egressInfo;
    if (!egressInfo || egressInfo.status !== "EGRESS_COMPLETE") return new Response("ok", { status: 200 });

    // Parse lectureId from filename (<lectureId>_recording.mp4)
    const fileResult = egressInfo.fileResults?.[0];
    const filename   = fileResult?.filename || "";
    const match      = filename.match(/^(.+)_recording\.mp4$/);
    const lectureId  = match ? match[1] : null;

    if (!lectureId) {
      console.error("[egress-webhook] No lectureId in filename:", filename);
      return new Response("ok", { status: 200 });
    }

    // Get course_id for this lecture (needed for storage_assets RLS)
    const { data: lecture } = await supabase
      .from("lectures")
      .select("course_id")
      .eq("id", lectureId)
      .single();

    const courseId = lecture?.course_id || "";

    // Download the recording from LiveKit egress download URL
    const downloadUrl = fileResult?.downloadUrl || fileResult?.location;
    if (!downloadUrl) {
      console.error("[egress-webhook] No download URL in egress result");
      return new Response("ok", { status: 200 });
    }

    console.log(`[egress-webhook] Downloading recording for lecture ${lectureId}...`);
    const videoRes = await fetch(downloadUrl);
    if (!videoRes.ok) throw new Error(`Download failed: ${videoRes.status}`);

    const videoBuffer  = await videoRes.arrayBuffer();
    const videoBytes   = new Uint8Array(videoBuffer);
    const totalChunks  = Math.ceil(videoBytes.length / CHUNK_SIZE);
    const assetId      = lectureId; // use lectureId as assetId for easy lookup
    const tag          = `asset-${assetId}`;

    console.log(`[egress-webhook] Uploading ${totalChunks} chunks to GitHub...`);

    // Register asset in Supabase
    await supabase.from("storage_assets").upsert({
      id:           assetId,
      type:         "video",
      lecture_id:   lectureId,
      course_id:    courseId,
      total_chunks: totalChunks,
      mime_type:    "video/mp4",
      status:       "uploading",
      created_at:   new Date().toISOString(),
    });

    const releaseId = await ensureRelease(tag);

    // Upload chunks
    for (let i = 0; i < totalChunks; i++) {
      const start     = i * CHUNK_SIZE;
      const end       = Math.min(start + CHUNK_SIZE, videoBytes.length);
      const chunk     = videoBytes.slice(start, end);
      const chunkName = `${assetId}.chunk${String(i).padStart(4, "0")}.bin`;
      const url       = await uploadChunk(releaseId, chunkName, chunk);

      await supabase.from("storage_chunks").upsert({
        asset_id:    assetId,
        chunk_index: i,
        url,
        type:        "video",
        uploaded_at: new Date().toISOString(),
      });

      console.log(`[egress-webhook] Chunk ${i + 1}/${totalChunks} uploaded`);
    }

    // Mark complete
    await supabase.from("storage_assets").update({ status: "complete" }).eq("id", assetId);

    // Update lecture — store assetId in video_url, prefixed so app knows to use proxy
    await supabase.from("lectures").update({
      video_url: `storage:${assetId}`,
      live:      false,
    }).eq("id", lectureId);

    console.log(`[egress-webhook] Lecture ${lectureId} recording stored as asset ${assetId}`);
    return new Response("ok", { status: 200 });

  } catch (err) {
    console.error("[egress-webhook] Error:", err);
    return new Response(String(err), { status: 500 });
  }
});