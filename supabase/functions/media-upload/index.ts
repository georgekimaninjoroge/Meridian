/**
 * media-upload — Meridian Storage (Supabase Storage)
 *
 * DEPLOY: supabase functions deploy media-upload --no-verify-jwt
 * (Firebase tokens fail Supabase's built-in JWT check — we verify manually.)
 *
 * Receives a ≤5 MB chunk, stores at:  lecture-media/{assetId}/{00000}
 * Records in storage_chunks + storage_assets tables.
 *
 * REQUEST (multipart/form-data):
 *   file        — Blob
 *   assetId     — string (lectureId / UUID)
 *   chunkIndex  — number (0-based)
 *   totalChunks — number
 *   mimeType    — string ("video/mp4")
 *   type        — string ("video" | "pdf")
 *   courseId    — string
 *
 * RESPONSE: { assetId, chunkIndex, storagePath, complete }
 *
 * Secrets used (all default or already set):
 *   SUPABASE_URL            — default
 *   SUPABASE_SERVICE_ROLE_KEY — default
 *   FIREBASE_PROJECT_ID     — custom (already set)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = "lecture-media";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── Verify Firebase ID token (same pattern as get-config) ─────────────────────
const FB_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID")!;

function decodeFirebaseToken(token: string): string | null {
  try {
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now)             return null;
    if (payload.aud !== FB_PROJECT_ID) return null;
    if (!payload.sub)                  return null;
    return payload.sub as string; // uid
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    const token = req.headers.get("Authorization")?.replace("Bearer ", "").trim();
    if (!token) return json({ error: "Unauthorized" }, 401);
    const uid = decodeFirebaseToken(token);
    if (!uid)  return json({ error: "Invalid token" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SB_SERVICE_KEY")!,
    );

    // ── Parse form ───────────────────────────────────────────────────────────
    const form        = await req.formData();
    const file        = form.get("file")        as File;
    const assetId     = form.get("assetId")     as string;
    const chunkIndex  = parseInt(form.get("chunkIndex")  as string);
    const totalChunks = parseInt(form.get("totalChunks") as string);
    const mimeType    = form.get("mimeType")    as string || "video/mp4";
    const type        = form.get("type")        as string || "video";
    const courseId    = form.get("courseId")    as string || null;

    if (!file || !assetId) return json({ error: "Missing fields" }, 400);
    if (file.size > 6 * 1024 * 1024) return json({ error: "Chunk too large" }, 413);

    // ── Upload chunk to storage ──────────────────────────────────────────────
    // Path: {assetId}/{chunkIndex padded to 5 digits}
    const chunkKey    = String(chunkIndex).padStart(5, "0");
    const storagePath = `${assetId}/${chunkKey}`;

    const { error: storageErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, new Uint8Array(await file.arrayBuffer()), {
        contentType: "application/octet-stream",
        upsert:      true,
      });

    if (storageErr) throw new Error(`Storage: ${storageErr.message}`);

    // ── Ensure asset row exists (FK parent) before inserting chunk ───────────
    const { error: assetInitErr } = await supabase.from("storage_assets").upsert({
      id:           assetId,
      type,
      total_chunks: totalChunks,
      mime_type:    mimeType,
      course_id:    courseId,
      status:       "uploading",
      created_at:   new Date().toISOString(),
    }, { onConflict: "id", ignoreDuplicates: false });
    if (assetInitErr) throw new Error(assetInitErr.message);

    // ── Record chunk in DB ───────────────────────────────────────────────────
    const { error: chunkErr } = await supabase.from("storage_chunks").upsert({
      asset_id:    assetId,
      chunk_index: chunkIndex,
      url:         storagePath,
      type,
      uploaded_at: new Date().toISOString(),
    });
    if (chunkErr) throw new Error(chunkErr.message);

    // ── Mark complete on last chunk ──────────────────────────────────────────
    const complete = chunkIndex === totalChunks - 1;
    if (complete) {
      const { error: assetErr } = await supabase.from("storage_assets").update({
        status: "complete",
      }).eq("id", assetId);
      if (assetErr) throw new Error(assetErr.message);
    }

    return json({ assetId, chunkIndex, storagePath, complete });

  } catch (e) {
    console.error("[media-upload]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});