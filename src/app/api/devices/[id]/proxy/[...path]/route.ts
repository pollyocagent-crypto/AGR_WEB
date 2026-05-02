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

  // Collect request body as plain text (all device API endpoints use JSON).
  let body: string | undefined;
  let contentType: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.text();
    contentType = req.headers.get("content-type") ?? undefined;
  }

  // Separate path from query string for firmware dispatcher.
  const search = req.nextUrl.search.slice(1); // strip leading "?"

  // AGR-139 firmware protocol: action="http_request" with plain body.
  const payload = {
    action: "http_request",
    method: req.method,
    path: devicePath,
    ...(search ? { query: search } : {}),
    ...(body ? { body } : {}),
    ...(contentType ? { content_type: contentType } : {}),
  };

  // Use request_command RPC (enforces ownership via security definer).
  const { data: cmdId, error: insertErr } = await supabase.rpc("request_command", {
    p_device_id: deviceId,
    p_payload: payload,
  });

  if (insertErr || !cmdId) {
    console.error("[proxy] insert command error:", insertErr);
    return NextResponse.json({ error: "Failed to queue command" }, { status: 500 });
  }

  // Poll until the device acks (status != 'pending' / 'sent') or timeout.
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const { data: row, error: pollErr } = await supabase
      .from("device_commands")
      .select("status, result")
      .eq("id", cmdId as string)
      .single();

    if (pollErr) {
      console.error("[proxy] poll error:", pollErr);
      continue;
    }

    if (row.status === "pending" || row.status === "sent") continue;

    if (row.status === "failed" || !row.result) {
      return NextResponse.json({ error: "Device returned an error" }, { status: 502 });
    }

    // result shape from firmware: { status: number, content_type?: string, body: string }
    const result = row.result as { status: number; content_type?: string; body: string };
    const responseBody = result.body ?? "";

    return new NextResponse(responseBody, {
      status: result.status ?? 200,
      headers: {
        "content-type": result.content_type ?? "application/json",
        "cache-control": "no-store",
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
