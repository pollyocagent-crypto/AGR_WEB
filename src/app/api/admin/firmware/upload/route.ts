import { createHash } from "crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { getR2Client, R2_BUCKET } from "@/lib/r2/client";
import { createAdminClient, createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  // Auth check
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!(await isAdmin(user.id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Parse multipart form
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const version = (formData.get("version") as string | null)?.trim();
  const notes = (formData.get("notes") as string | null)?.trim() || null;

  if (!file || !version) {
    return NextResponse.json({ error: "file and version are required" }, { status: 400 });
  }

  if (!version.match(/^[\w.\-]+$/)) {
    return NextResponse.json({ error: "Invalid version format" }, { status: 400 });
  }

  // Read file bytes
  const buffer = Buffer.from(await file.arrayBuffer());

  // SHA-256
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  // R2 object key
  const objectKey = `firmware/agr-${version}.bin`;

  // Upload to R2
  try {
    const r2 = getR2Client();
    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: objectKey,
        Body: buffer,
        ContentType: "application/octet-stream",
        ContentLength: buffer.length,
      })
    );
  } catch (err) {
    console.error("R2 upload failed", err);
    return NextResponse.json({ error: "R2 upload failed" }, { status: 500 });
  }

  // Insert into firmware_releases (service_role to bypass RLS)
  const admin = createAdminClient();
  const { error: dbErr } = await admin.from("firmware_releases").insert({
    version,
    r2_object_key: objectKey,
    sha256,
    notes,
    is_active: false,
  });

  if (dbErr) {
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }

  return NextResponse.json({ version, sha256, objectKey });
}
