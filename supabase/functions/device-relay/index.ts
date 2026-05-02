/**
 * device-relay — WebSocket endpoint for ESP32 HMI devices.
 *
 * Protocol:
 *   Device connects with: Authorization: Bearer <device-jwt>
 *   JWT must contain claim: device_id (uuid)
 *
 * Messages device → cloud:
 *   { type: "state",  state: {...}, ts: <epoch> }
 *   { type: "ack",    command_id: "<uuid>", ok: boolean, result?: {...} }
 *   { type: "event",  kind: "boot"|"error"|..., data?: {...}, ts?: <epoch> }
 *   { type: "ping" }  (heartbeat from device every 30 s)
 *
 * Messages cloud → device:
 *   { type: "command", id: "<uuid>", payload: {...} }
 *   { type: "pong" }
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { jwtVerify, type JWTPayload } from "jose";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("AGR_JWT_SECRET")!;

const HEARTBEAT_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// JWT validation
// ---------------------------------------------------------------------------

interface DeviceJwtPayload extends JWTPayload {
  device_id: string;
}

async function validateDeviceJwt(token: string): Promise<DeviceJwtPayload> {
  const secret = new TextEncoder().encode(JWT_SECRET);
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ["HS256"],
  });

  if (typeof payload.device_id !== "string" || !payload.device_id) {
    throw new Error("JWT missing device_id claim");
  }

  return payload as DeviceJwtPayload;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleState(
  supabase: SupabaseClient,
  deviceId: string,
  msg: { state: unknown }
): Promise<void> {
  const { error } = await supabase
    .from("device_state")
    .upsert(
      { device_id: deviceId, state: msg.state, updated_at: new Date().toISOString() },
      { onConflict: "device_id" }
    );
  if (error) console.error(`[device-relay] state upsert error ${deviceId}:`, error);
}

async function handleAck(
  supabase: SupabaseClient,
  deviceId: string,
  msg: { command_id: string; ok: boolean; result?: unknown }
): Promise<void> {
  const newStatus = msg.ok ? "acked" : "failed";
  const update: Record<string, unknown> = {
    status: newStatus,
    acked_at: new Date().toISOString(),
  };
  // For http-type commands the device echoes back {status, content_type, body_b64}.
  // Store it so the Vercel proxy route can retrieve it via polling.
  if (msg.result !== undefined) {
    update.result = msg.result;
  }
  const { error } = await supabase
    .from("device_commands")
    .update(update)
    .eq("id", msg.command_id)
    .eq("device_id", deviceId);
  if (error) console.error(`[device-relay] ack update error ${deviceId}:`, error);
}

async function handleEvent(
  supabase: SupabaseClient,
  deviceId: string,
  msg: { kind: string; data?: unknown; ts?: number }
): Promise<void> {
  const { error } = await supabase.from("device_events").insert({
    device_id: deviceId,
    kind: msg.kind,
    data: msg.data ?? null,
    ts: msg.ts ?? null,
  });
  if (error) console.error(`[device-relay] event insert error ${deviceId}:`, error);
}

async function updateLastSeen(supabase: SupabaseClient, deviceId: string): Promise<void> {
  const { error } = await supabase
    .from("devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", deviceId);
  if (error) console.error(`[device-relay] last_seen_at update error ${deviceId}:`, error);
}

// ---------------------------------------------------------------------------
// Drain pending commands on connect (catch-up)
// ---------------------------------------------------------------------------

async function drainPendingCommands(
  supabase: SupabaseClient,
  deviceId: string,
  ws: WebSocket
): Promise<void> {
  const { data: commands, error } = await supabase
    .from("device_commands")
    .select("id, payload")
    .eq("device_id", deviceId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    console.error(`[device-relay] fetch pending commands error ${deviceId}:`, error);
    return;
  }

  for (const cmd of commands ?? []) {
    if (ws.readyState !== WebSocket.OPEN) break;

    ws.send(JSON.stringify({ type: "command", id: cmd.id, payload: cmd.payload }));

    const { error: updateErr } = await supabase
      .from("device_commands")
      .update({ status: "sent" })
      .eq("id", cmd.id);
    if (updateErr) {
      console.error(`[device-relay] status->sent error cmd=${cmd.id}:`, updateErr);
    }
  }
}

// ---------------------------------------------------------------------------
// Realtime subscription — push new commands as they arrive
// ---------------------------------------------------------------------------

function subscribeToNewCommands(
  supabase: SupabaseClient,
  deviceId: string,
  ws: WebSocket
): ReturnType<SupabaseClient["channel"]> {
  return supabase
    .channel(`device_commands:${deviceId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "device_commands",
        filter: `device_id=eq.${deviceId}`,
      },
      async (payload) => {
        const cmd = payload.new as { id: string; payload: unknown; status: string };
        if (cmd.status !== "pending" || ws.readyState !== WebSocket.OPEN) return;

        ws.send(JSON.stringify({ type: "command", id: cmd.id, payload: cmd.payload }));

        const { error } = await supabase
          .from("device_commands")
          .update({ status: "sent" })
          .eq("id", cmd.id);
        if (error) {
          console.error(`[device-relay] realtime status->sent error cmd=${cmd.id}:`, error);
        }
      }
    )
    .subscribe();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const upgradeHeader = req.headers.get("upgrade") ?? "";
  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return new Response("Missing Authorization header", { status: 401 });
  }

  let devicePayload: DeviceJwtPayload;
  try {
    devicePayload = await validateDeviceJwt(token);
  } catch (err) {
    console.error("[device-relay] JWT validation failed:", err);
    return new Response("Invalid device JWT", { status: 401 });
  }

  const deviceId = devicePayload.device_id;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Verify device exists
  const { data: device, error: deviceErr } = await supabase
    .from("devices")
    .select("id")
    .eq("id", deviceId)
    .maybeSingle();

  if (deviceErr || !device) {
    console.error(`[device-relay] device not found: ${deviceId}`, deviceErr);
    return new Response("Device not registered", { status: 403 });
  }

  const { socket: ws, response } = Deno.upgradeWebSocket(req);

  let lastMessageAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let realtimeChannel: ReturnType<SupabaseClient["channel"]> | null = null;

  function resetTimeout() {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    lastMessageAt = Date.now();
    timeoutHandle = setTimeout(async () => {
      if (Date.now() - lastMessageAt >= HEARTBEAT_TIMEOUT_MS) {
        console.error(`[device-relay] heartbeat timeout for device ${deviceId}`);
        await updateLastSeen(supabase, deviceId);
        ws.close(4000, "heartbeat timeout");
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  ws.onopen = async () => {
    console.log(`[device-relay] connected: ${deviceId}`);
    await updateLastSeen(supabase, deviceId);
    resetTimeout();
    await drainPendingCommands(supabase, deviceId, ws);
    realtimeChannel = subscribeToNewCommands(supabase, deviceId, ws);
  };

  ws.onmessage = async (event: MessageEvent) => {
    resetTimeout();

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      console.error(`[device-relay] invalid JSON from ${deviceId}:`, event.data);
      return;
    }

    switch (msg.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;

      case "state":
        await handleState(supabase, deviceId, msg as { state: unknown; ts?: number });
        break;

      case "ack":
        if (typeof msg.command_id !== "string") {
          console.error(`[device-relay] ack missing command_id from ${deviceId}`);
          break;
        }
        await handleAck(
          supabase,
          deviceId,
          msg as { command_id: string; ok: boolean; result?: unknown }
        );
        break;

      case "event":
        if (typeof msg.kind !== "string") {
          console.error(`[device-relay] event missing kind from ${deviceId}`);
          break;
        }
        await handleEvent(
          supabase,
          deviceId,
          msg as {
            kind: string;
            data?: unknown;
            ts?: number;
          }
        );
        break;

      default:
        console.error(`[device-relay] unknown message type from ${deviceId}:`, msg.type);
    }
  };

  ws.onclose = async () => {
    console.log(`[device-relay] disconnected: ${deviceId}`);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
    await updateLastSeen(supabase, deviceId);
  };

  ws.onerror = (err) => {
    console.error(`[device-relay] WS error for ${deviceId}:`, err);
  };

  return response;
});
