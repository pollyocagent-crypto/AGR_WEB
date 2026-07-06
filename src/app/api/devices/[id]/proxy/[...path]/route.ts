/**
 * Generic HTTP proxy for the embedded device web UI.
 * AGR-140: forwards HTTP requests to the device over the WSS relay.
 *
 * Flow:
 *   Browser  → POST /api/devices/{id}/proxy/api/channel
 *   Route    → INSERT device_commands {type:'http', method, path, headers, body_b64}
 *   Relay    → forwards command to device over WSS
 *   Device   → processes request, sends ACK with {status, content_type, body_b64}
 *   Relay    → writes result into device_commands.result
 *   Route    → polls until acked (max 10 s), returns body to browser
 */

import { createClient } from "@/lib/supabase/server";
import { relayHttpRequest, RelayError } from "@/lib/relay";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Binary OTA routes — too large to relay over WSS; keep using direct LAN.
const BLOCKED_PATHS = ["/api/ota"];

interface Params {
  params: Promise<{ id: string; path: string[] }>;
}

async function handleProxy(req: NextRequest, params: Params): Promise<NextResponse> {
  const { id: deviceId, path: pathSegments } = await params.params;
  const devicePath = "/" + pathSegments.join("/");

  // Block binary OTA routes — not supported via cloud relay.
  if (BLOCKED_PATHS.some((p) => devicePath.startsWith(p))) {
    return NextResponse.json({ error: "OTA not supported via cloud proxy" }, { status: 501 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify the user owns or is a member of this device (RLS-safe check).
  const { data: ownership } = await supabase
    .from("device_owners")
    .select("role")
    .eq("device_id", deviceId)
    .maybeSingle();

  if (!ownership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Collect request body as base64 (AGR-142 firmware protocol uses body_b64).
  let bodyB64: string | null = null;
  const forwardHeaders: Record<string, string> = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    const bodyBytes = await req.arrayBuffer();
    if (bodyBytes.byteLength > 0) {
      bodyB64 = Buffer.from(bodyBytes).toString("base64");
    }
    const ct = req.headers.get("content-type");
    if (ct) forwardHeaders["content-type"] = ct;
  }

  // Append query string to path; firmware reads the full path including query.
  const search = req.nextUrl.search;
  const fullPath = search ? `${devicePath}${search}` : devicePath;

  try {
    const relayed = await relayHttpRequest(supabase, deviceId, {
      method: req.method,
      path: fullPath,
      headers: forwardHeaders,
      bodyB64,
    });

    return new NextResponse(relayed.body, {
      status: relayed.status,
      headers: {
        "content-type": relayed.contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof RelayError) {
      const status = err.kind === "timeout" ? 504 : err.kind === "device" ? 502 : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    console.error("[proxy] unexpected relay error:", err);
    return NextResponse.json({ error: "Proxy error" }, { status: 500 });
  }
}

export const GET = (req: NextRequest, params: Params) => handleProxy(req, params);
export const POST = (req: NextRequest, params: Params) => handleProxy(req, params);
export const PUT = (req: NextRequest, params: Params) => handleProxy(req, params);
export const DELETE = (req: NextRequest, params: Params) => handleProxy(req, params);
export const PATCH = (req: NextRequest, params: Params) => handleProxy(req, params);
