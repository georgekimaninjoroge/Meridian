/**
 * media-proxy — Meridian Storage
 *
 * Gates access to GitHub Release asset URLs behind JWT auth.
 * Supports HTTP Range requests for video seeking and 5s chunk streaming.
 *
 * USAGE:
 *   GET /functions/v1/media-proxy?assetId=<id>&chunk=<index>
 *   Header: Authorization: Bearer <firebase_or_supabase_jwt>
 *
 * For single-file assets (PDFs): omit chunk param
 * For chunked video: pass chunk=0,1,2... or omit for full reassembly URL
 *
 * SECRETS:
 *   GITHUB_PAT           — for re-fetching asset URLs if needed
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   FIREBASE_PROJECT_ID  — for verifying Firebase JWTs
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL         = Deno.env.get("SUPABASE_URL")!;
const SB_KEY         = Deno.env.get("SB_SERVICE_KEY")!;
const FB_PROJECT_ID  = Deno.env.get("FIREBASE_PROJECT_ID")!;

// ─── Verify Firebase ID token ─────────────────────────────────────────────────
async function verifyFirebaseToken(token: string): Promise<string | null> {
  try {
    // Fetch Firebase public keys
    const keysRes = await fetch(
      "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
    );
    if (!keysRes.ok) return null;
    const keys = await keysRes.json();

    // Decode header to find which key to use
    const [headerB64] = token.split(".");
    const header = JSON.parse(atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")));
    const publicKeyPem = keys[header.kid];
    if (!publicKeyPem) return null;

    // Import the public key
    const pemBody = publicKeyPem
      .replace("-----BEGIN CERTIFICATE-----", "")
      .replace("-----END CERTIFICATE-----", "")
      .replace(/\n/g, "");
    const certDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      "spki", certDer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["verify"]
    );

    // Verify + decode payload
    const [, payloadB64, sigB64] = token.split(".");
    const signingInput  = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature     = Uint8Array.from(
      atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signingInput);
    if (!valid) return null;

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));

    // Validate claims
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now)               return null;
    if (payload.iat > now + 300)         return null;
    if (payload.aud !== FB_PROJECT_ID)   return null;
    if (payload.iss !== `https://securetoken.google.com/${FB_PROJECT_ID}`) return null;

    return payload.sub; // uid
  } catch {
    return null;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "authorization, range, apikey",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }

  try {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const token      = authHeader.replace("Bearer ", "").trim();
    if (!token) return err("Unauthorized", 401);

    const uid = await verifyFirebaseToken(token);
    if (!uid)  return err("Invalid token", 401);

    // ── Parse params ─────────────────────────────────────────────────────────
    const url        = new URL(req.url);
    const assetId    = url.searchParams.get("assetId");
    const chunkParam = url.searchParams.get("chunk");

    if (!assetId) return err("Missing assetId", 400);

    // ── Verify enrollment (student must be enrolled in the course) ────────────
    const supabase = createClient(SB_URL, SB_KEY);
    const { data: asset } = await supabase
      .from("storage_assets")
      .select("id, type, lecture_id, course_id, status")
      .eq("id", assetId)
      .single();

    if (!asset || asset.status !== "complete") return err("Asset not found", 404);

    // Check enrollment
    if (asset.course_id) {
      const { data: enrollment } = await supabase
        .from("enrollments")
        .select("id")
        .eq("student_id", uid)
        .eq("course_id", asset.course_id)
        .maybeSingle();

      // Also allow teachers — check if they own the course
      const { data: course } = await supabase
        .from("courses")
        .select("teacher_id")
        .eq("id", asset.course_id)
        .single();

      const isTeacher = course?.teacher_id === uid;
      if (!enrollment && !isTeacher) return err("Not enrolled", 403);
    }

    // ── Get the GitHub URL for this chunk ─────────────────────────────────────
    let query = supabase
      .from("storage_chunks")
      .select("url")
      .eq("asset_id", assetId);

    if (chunkParam !== null) {
      query = query.eq("chunk_index", parseInt(chunkParam));
    } else {
      query = query.eq("chunk_index", 0); // PDF or single file
    }

    const { data: chunks } = await query;
    if (!chunks?.length) return err("Chunk not found", 404);

    const githubUrl = chunks[0].url;

    // ── Proxy the request with range header passthrough ───────────────────────
    const rangeHeader = req.headers.get("Range");
    const fetchHeaders: Record<string, string> = {
      Authorization: `Bearer ${Deno.env.get("GITHUB_PAT")}`,
      Accept:        "application/octet-stream",
    };
    if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

    const upstream = await fetch(githubUrl, { headers: fetchHeaders });

    // Pass through the response with correct headers for range support
    const responseHeaders = new Headers({
      "Content-Type":                upstream.headers.get("Content-Type") || "application/octet-stream",
      "Accept-Ranges":               "bytes",
      "Access-Control-Allow-Origin": "*",
    });

    // Forward range-related headers
    for (const h of ["Content-Length", "Content-Range"]) {
      const v = upstream.headers.get(h);
      if (v) responseHeaders.set(h, v);
    }

    return new Response(upstream.body, {
      status:  upstream.status,
      headers: responseHeaders,
    });

  } catch (e) {
    console.error("[media-proxy]", e);
    return err(String(e), 500);
  }
});

function err(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}