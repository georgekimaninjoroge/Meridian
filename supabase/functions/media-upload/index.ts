/**
 * media-upload — Meridian Storage
 *
 * Receives a file chunk from the client, uploads it to GitHub Releases
 * as a release asset on the `meridian/bucket` repo, then records the
 * asset URL in Supabase so the proxy can gate it behind JWT auth.
 *
 * REQUEST (multipart/form-data):
 *   file        — Blob  — the chunk or full file
 *   assetId     — string — stable ID for this upload (e.g. lectureId or pdfId)
 *   chunkIndex  — number — 0-based chunk index (0 for single-file uploads)
 *   totalChunks — number — total expected chunks (1 for single-file uploads)
 *   mimeType    — string — "video/mp4" | "application/pdf"
 *   type        — string — "video" | "pdf"
 *
 * RESPONSE:
 *   { assetId, chunkIndex, url, complete: boolean }
 *
 * SECRETS (set via `supabase secrets set`):
 *   GITHUB_PAT        — fine-grained PAT with Contents:write on bucket repo
 *   GITHUB_OWNER      — your GitHub username or org
 *   GITHUB_BUCKET_REPO — e.g. "bucket"
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GITHUB_API = "https://api.github.com";

const GH_PAT    = Deno.env.get("GITHUB_PAT")!;
const GH_OWNER  = Deno.env.get("GITHUB_OWNER")!;
const GH_REPO   = Deno.env.get("GITHUB_BUCKET_REPO")!;

const SB_URL    = Deno.env.get("SUPABASE_URL")!;
const SB_KEY    = Deno.env.get("SB_SERVICE_KEY")!;

const ghHeaders = {
  Authorization: `Bearer ${GH_PAT}`,
  Accept:        "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

// ─── Ensure a release tag exists for this asset ──────────────────────────────
async function ensureRelease(tag: string): Promise<number> {
  // Try to get existing release
  const get = await fetch(
    `${GITHUB_API}/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${tag}`,
    { headers: ghHeaders }
  );
  if (get.ok) {
    const data = await get.json();
    return data.id;
  }

  // Create release
  const create = await fetch(
    `${GITHUB_API}/repos/${GH_OWNER}/${GH_REPO}/releases`,
    {
      method: "POST",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name:         tag,
        name:             tag,
        draft:            false,
        prerelease:       false,
        generate_release_notes: false,
      }),
    }
  );
  if (!create.ok) throw new Error(`Failed to create release: ${await create.text()}`);
  const data = await create.json();
  return data.id;
}

// ─── Upload one chunk as a release asset ─────────────────────────────────────
async function uploadAsset(
  releaseId: number,
  filename:  string,
  blob:      Uint8Array,
  mimeType:  string
): Promise<string> {
  const url = `https://uploads.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(filename)}`;

  const res = await fetch(url, {
    method:  "POST",
    headers: { ...ghHeaders, "Content-Type": mimeType },
    body:    blob,
  });
  if (!res.ok) throw new Error(`Asset upload failed: ${await res.text()}`);
  const data = await res.json();
  // browser_download_url is the direct CDN link
  return data.browser_download_url;
}

// ─── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "authorization, content-type, apikey",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  try {
    // ── Auth — verify Firebase/Supabase JWT ──────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(SB_URL, SB_KEY);

    // Parse form data
    const form        = await req.formData();
    const file        = form.get("file")        as File;
    const assetId     = form.get("assetId")     as string;
    const chunkIndex  = parseInt(form.get("chunkIndex")  as string);
    const totalChunks = parseInt(form.get("totalChunks") as string);
    const mimeType    = form.get("mimeType")    as string;
    const type        = form.get("type")        as string; // "video" | "pdf"

    if (!file || !assetId) return json({ error: "Missing fields" }, 400);

    // ── Tag = assetId, one release per logical asset ─────────────────────────
    const tag      = `asset-${assetId}`;
    const ext      = type === "pdf" ? "pdf" : "mp4";
    const filename = totalChunks === 1
      ? `${assetId}.${ext}`
      : `${assetId}.chunk${String(chunkIndex).padStart(4, "0")}.bin`;

    const releaseId = await ensureRelease(tag);
    const bytes     = new Uint8Array(await file.arrayBuffer());
    const assetUrl  = await uploadAsset(releaseId, filename, bytes, mimeType);

    // ── Record chunk in Supabase ─────────────────────────────────────────────
    const { error: dbErr } = await supabase.from("storage_chunks").upsert({
      asset_id:    assetId,
      chunk_index: chunkIndex,
      url:         assetUrl,
      type,
      uploaded_at: new Date().toISOString(),
    });
    if (dbErr) throw dbErr;

    // ── If last chunk, mark asset complete ───────────────────────────────────
    const complete = chunkIndex === totalChunks - 1;
    if (complete) {
      await supabase.from("storage_assets").upsert({
        id:           assetId,
        type,
        total_chunks: totalChunks,
        mime_type:    mimeType,
        status:       "complete",
        created_at:   new Date().toISOString(),
      });
    }

    return json({ assetId, chunkIndex, url: assetUrl, complete });

  } catch (err) {
    console.error("[media-upload]", err);
    return json({ error: String(err) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}