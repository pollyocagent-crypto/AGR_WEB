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
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// How long to wait for the device to respond before returning 504.
const TIMEOUT_MS = 10_000;
// Polling interval while waiting for the device ack.
const POLL_INTERVAL_MS = 200;

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

  // Collect request body as base64 (safe for any content-type).
  const bodyBytes = await req.arrayBuffer();
  const bodyB64 = bodyBytes.byteLength > 0 ? Buffer.from(bodyBytes).toString("base64") : null;

  // Forward only safe headers (skip host/connection/cookie).
  const forwardHeaders: Record<string, string> = {};
  const passthrough = ["content-type", "accept", "accept-language"];
  for (const h of passthrough) {
    const v = req.headers.get(h);
    if (v) forwardHeaders[h] = v;
  }

  // Append the query string to the device path.
  const search = req.nextUrl.search;
  const fullPath = search ? `${devicePath}${search}` : devicePath;

  const payload = {
    type: "http",
    method: req.method,
    path: fullPath,
    headers: forwardHeaders,
    body_b64: bodyB64,
  };

  // Insert the command — device-relay picks it up and forwards over WSS.
  const { data: cmd, error: insertErr } = await supabase
    .from("device_commands")
    .insert({
      device_id: deviceId,
      payload,
      requested_by: user.id,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertErr || !cmd) {
    console.error("[proxy] insert command error:", insertErr);
    return NextResponse.json({ error: "Failed to queue command" }, { status: 500 });
  }

  const cmdId = cmd.id as string;

  // Poll until the device acks (status != 'pending' / 'sent') or timeout.
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const { data: row, error: pollErr } = await supabase
      .from("device_commands")
      .select("status, result")
      .eq("id", cmdId)
      .single();

    if (pollErr) {
      console.error("[proxy] poll error:", pollErr);
      continue;
    }

    if (row.status === "pending" || row.status === "sent") continue;

    if (row.status === "failed" || !row.result) {
      return NextResponse.json({ error: "Device returned an error" }, { status: 502 });
    }

    // result shape: { status: number, content_type: string, body_b64: string }
    const result = row.result as { status: number; content_type: string; body_b64: string };
    const bodyBuf = Buffer.from(result.body_b64 ?? "", "base64");

    return new NextResponse(bodyBuf, {
      status: result.status ?? 200,
      headers: {
        "content-type": result.content_type ?? "application/octet-stream",
        "cache-control": "no-store",
        // Prevent browser from interpreting device HTML as a top-level document.
        "x-content-type-options": "nosniff",
      },
    });
  }

  return NextResponse.json({ error: "Device timeout" }, { status: 504 });
}

export const GET = (req: NextRequest, params: Params) => handleProxy(req, params);
export const POST = (req: NextRequest, params: Params) => handleProxy(req, params);
export const PUT = (req: NextRequest, params: Params) => handleProxy(req, params);
export const DELETE = (req: NextRequest, params: Params) => handleProxy(req, params);
export const PATCH = (req: NextRequest, params: Params) => handleProxy(req, params);
