/**
 * device-bootstrap — one-time registration endpoint for ESP32 HMI devices.
 *
 * POST /functions/v1/device-bootstrap
 * Body: { device_uid: string }  (no Authorization header required)
 *
 * Response:
 *   { device_id: string, jwt: string, pairing_code: string }
 *
 * Idempotent: if device_uid already exists, returns existing device_id + fresh JWT
 * and refreshes the pairing_code.
 *
 * Called once at first boot; safe to retry after OTA (same device_uid, same device_id).
 */

import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("AGR_JWT_SECRET")!;

const DEVICE_JWT_EXPIRY = "365d";
const PAIRING_CODE_TTL_HOURS = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Must match k_pair_alpha in screen_pairing.c and the web app filter [A-HJ-NP-Z2-9]
const PAIR_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars

function generatePairingCode(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => PAIR_ALPHA[b % 32])
    .join("");
}

async function issueDeviceJwt(deviceId: string): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET);
  return await new SignJWT({ device_id: deviceId, role: "device" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(deviceId)
    .setIssuedAt()
    .setExpirationTime(DEVICE_JWT_EXPIRY)
    .sign(secret);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: { device_uid?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const deviceUid = body.device_uid;
  if (typeof deviceUid !== "string" || !deviceUid.trim()) {
    return new Response(JSON.stringify({ error: "device_uid is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ---------------------------------------------------------------------------
  // Upsert device row (idempotent on device_uid)
  // ---------------------------------------------------------------------------
  const { data: device, error: deviceErr } = await supabase
    .from("devices")
    .upsert({ device_uid: deviceUid.trim() }, { onConflict: "device_uid", ignoreDuplicates: false })
    .select("id")
    .maybeSingle();

  if (deviceErr || !device) {
    console.error("[device-bootstrap] upsert device error:", deviceErr);
    return new Response(JSON.stringify({ error: "Failed to register device" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const deviceId: string = device.id;

  // ---------------------------------------------------------------------------
  // Issue device JWT
  // ---------------------------------------------------------------------------
  const jwt = await issueDeviceJwt(deviceId);

  // ---------------------------------------------------------------------------
  // Generate / refresh pairing code
  // ---------------------------------------------------------------------------
  const pairingCode = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_HOURS * 60 * 60 * 1000).toISOString();

  // Delete any existing codes for this device, then insert a fresh one
  await supabase.from("pairing_codes").delete().eq("device_id", deviceId);

  const { error: codeErr } = await supabase.from("pairing_codes").insert({
    code: pairingCode,
    device_id: deviceId,
    expires_at: expiresAt,
  });

  if (codeErr) {
    console.error("[device-bootstrap] pairing_code insert error:", codeErr);
    // Non-fatal: device still registered; pairing will need retry
  }

  console.log(`[device-bootstrap] registered device_uid=${deviceUid} id=${deviceId}`);

  return new Response(JSON.stringify({ device_id: deviceId, jwt, pairing_code: pairingCode }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
});
