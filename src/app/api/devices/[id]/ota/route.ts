import { NextResponse } from "next/server";
import { presignFirmwareUrl } from "@/lib/r2/presign";
import { createAdminClient, createClient } from "@/lib/supabase/server";

interface Props {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, { params }: Props) {
  const { id: deviceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Verify ownership via RLS — if this returns data the user owns the device
  const { data: ownership } = await supabase
    .from("device_owners")
    .select("role")
    .eq("device_id", deviceId)
    .maybeSingle();

  if (!ownership) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  // Get the active firmware release (service_role for firmware_releases INSERT check)
  const admin = createAdminClient();
  const { data: firmware, error: fwErr } = await admin
    .from("firmware_releases")
    .select("version, r2_object_key, sha256")
    .eq("is_active", true)
    .maybeSingle();

  if (fwErr || !firmware) {
    return NextResponse.json({ error: "No active firmware release" }, { status: 404 });
  }

  // Generate presigned URL valid for 1 hour
  let url: string;
  try {
    url = await presignFirmwareUrl(firmware.r2_object_key, 3600);
  } catch (err) {
    console.error("presign failed", err);
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }

  // Insert OTA command via the request_command RPC (respects RLS + ownership check)
  const { error: cmdErr } = await supabase.rpc("request_command", {
    p_device_id: deviceId,
    p_payload: { type: "ota", url, sha256: firmware.sha256, version: firmware.version },
  });

  if (cmdErr) return NextResponse.json({ error: cmdErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, version: firmware.version });
}
