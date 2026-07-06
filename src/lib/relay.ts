/**
 * Cloud → device HTTP relay helper (AGR-140 / AGR-206).
 *
 * Forwards a single HTTP request to the device's embedded LAN web UI
 * (`hmi_web` REST) over the WSS relay and returns the device's response.
 *
 * Flow:
 *   request_command RPC inserts a {type:'http', method, path, ...} command →
 *   device-relay forwards it over WSS → device replies with an ack carrying
 *   {status, content_type, body_b64} → relay writes it into device_commands.result →
 *   we poll until the command leaves 'pending'/'sent' and return the payload.
 *
 * Shared by the generic proxy route and the /control entry page so the GEN-2
 * device UI is reachable remotely with one code path (proxy-first, AGR-206).
 */

import type { createClient } from "@/lib/supabase/server";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

// How long to wait for the device to answer before giving up.
const TIMEOUT_MS = 10_000;
// Polling interval while waiting for the device ack.
const POLL_INTERVAL_MS = 200;

export interface RelayRequest {
  method: string;
  /** Device-relative path incl. query string, e.g. "/api/state" or "/". */
  path: string;
  headers?: Record<string, string>;
  bodyB64?: string | null;
}

export interface RelayResponse {
  status: number;
  contentType: string;
  // Backed by an ArrayBuffer (not SharedArrayBuffer) so it satisfies BodyInit.
  body: Buffer<ArrayBuffer>;
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly kind: "queue" | "device" | "timeout"
  ) {
    super(message);
    this.name = "RelayError";
  }
}

/**
 * Relay one HTTP request to the device and await its response.
 * Ownership is enforced by the request_command RPC (security definer).
 * Throws {@link RelayError} on queue failure, device error, or timeout.
 */
export async function relayHttpRequest(
  supabase: ServerClient,
  deviceId: string,
  req: RelayRequest
): Promise<RelayResponse> {
  // AGR-142 firmware protocol: payload.type="http" with base64 body.
  const payload = {
    type: "http",
    method: req.method,
    path: req.path,
    headers: req.headers ?? {},
    body_b64: req.bodyB64 ?? null,
  };

  const { data: cmdId, error: insertErr } = await supabase.rpc("request_command", {
    p_device_id: deviceId,
    p_payload: payload,
  });

  if (insertErr || !cmdId) {
    throw new RelayError("Failed to queue command", "queue");
  }

  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const { data: row, error: pollErr } = await supabase
      .from("device_commands")
      .select("status, result")
      .eq("id", cmdId as string)
      .single();

    if (pollErr) continue;
    if (row.status === "pending" || row.status === "sent") continue;

    if (row.status === "failed" || !row.result) {
      throw new RelayError("Device returned an error", "device");
    }

    const result = row.result as { status: number; content_type?: string; body_b64?: string };
    return {
      status: result.status ?? 200,
      contentType: result.content_type ?? "application/octet-stream",
      body: Buffer.from(result.body_b64 ?? "", "base64"),
    };
  }

  throw new RelayError("Device timeout", "timeout");
}
