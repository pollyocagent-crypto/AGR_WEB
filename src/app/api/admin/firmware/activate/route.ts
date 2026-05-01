import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { createAdminClient, createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!(await isAdmin(user.id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const version = body?.version as string | undefined;
  if (!version) return NextResponse.json({ error: "version required" }, { status: 400 });

  const admin = createAdminClient();

  // Clear all active flags, then set the target
  const { error: clearErr } = await admin
    .from("firmware_releases")
    .update({ is_active: false })
    .neq("version", version);

  if (clearErr) return NextResponse.json({ error: clearErr.message }, { status: 500 });

  const { error: setErr } = await admin
    .from("firmware_releases")
    .update({ is_active: true })
    .eq("version", version);

  if (setErr) return NextResponse.json({ error: setErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
