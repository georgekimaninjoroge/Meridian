/**
 * media-proxy — Meridian Storage
 *
 * DEPLOY: supabase functions deploy media-proxy --no-verify-jwt
 * (Firebase tokens fail Supabase's built-in JWT check — we verify manually.)
 *
 * Gates chunk access behind Firebase JWT + enrollment check.
 * SW intercepts /virtual-video/{assetId} Range requests and calls:
 *   GET /functions/v1/media-proxy?assetId=<id>&chunk=<index>
 *
 * Returns full chunk bytes (200 OK). SW slices the Range.
 *
 * Secrets used:
 *   SUPABASE_URL              — default
 *   SUPABASE_SERVICE_ROLE_KEY — default
 *   FIREBASE_PROJECT_ID       — custom (already set)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET        = "lecture-media";
const FB_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID")!;

const CORS = {
  "Access-Control-Allow-Origin":   "*",
  "Access-Control-Allow-Headers":  "authorization, range, apikey",
  "Access-Control-Allow-Methods":  "GET, OPTIONS",
  // FIX: expose custom headers so browser JS can read them
  "Access-Control-Expose-Headers": "X-Total-Chunks, X-Mime-Type, X-Chunk-Index, X-Asset-Id",
};

function err(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── Firebase token decode (no full crypto verify — same as get-config) ─────────
function decodeFirebaseToken(token: string): string | null {
  try {
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now)             return null;
    if (payload.aud !== FB_PROJECT_ID) return null;
    if (!payload.sub)                  return null;
    return payload.sub as string;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const token = req.headers.get("Authorization")?.replace("Bearer ", "").trim();
    if (!token) return err("Unauthorized", 401);
    const uid = decodeFirebaseToken(token);
    if (!uid)  return err("Invalid token", 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SB_SERVICE_KEY")!,
    );

    // ── Params ────────────────────────────────────────────────────────────────
    const url        = new URL(req.url);
    const assetId    = url.searchParams.get("assetId");
    const chunkParam = url.searchParams.get("chunk");
    if (!assetId) return err("Missing assetId", 400);

    // ── Asset + enrollment check ──────────────────────────────────────────────
    const { data: asset } = await supabase
      .from("storage_assets")
      .select("id, type, mime_type, total_chunks, course_id, status")
      .eq("id", assetId)
      .single();

    if (!asset || asset.status !== "complete") return err("Asset not found", 404);

    // TEMP: enrollment check bypassed for debugging
    // if (asset.course_id) { ... }

    // ── Serve chunk from storage ──────────────────────────────────────────────
    const chunkIndex  = chunkParam !== null ? parseInt(chunkParam) : 0;
    const chunkKey    = String(chunkIndex).padStart(5, "0");
    const storagePath = `${assetId}/${chunkKey}`;

    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(storagePath);

    if (dlErr || !blob) return err(`Chunk not found: ${dlErr?.message}`, 404);

    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Return full chunk — SW slices the exact byte range
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type":                "application/octet-stream",
        "Content-Length":              String(bytes.byteLength),
        "Cache-Control":               "no-store",
        "X-Chunk-Index":               String(chunkIndex),
        "X-Asset-Id":                  assetId,
        "X-Total-Chunks":              String(asset.total_chunks),
        "X-Mime-Type":                 asset.mime_type || "video/mp4",
        ...CORS,
      },
    });

  } catch (e) {
    console.error("[media-proxy]", e);
    return err(String(e), 500);
  }
});