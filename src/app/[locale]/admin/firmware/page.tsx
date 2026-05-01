import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/admin";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { FirmwareManager } from "@/components/admin/firmware-manager";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Firmware Releases — AGR Admin" };

export default async function AdminFirmwarePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  if (!(await isAdmin(user.id))) redirect("/");

  const admin = createAdminClient();
  const { data: releases } = await admin
    .from("firmware_releases")
    .select("version, sha256, notes, published_at, is_active")
    .order("published_at", { ascending: false });

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-3xl font-bold">Firmware Releases</h1>
      <FirmwareManager initialReleases={releases ?? []} />
    </main>
  );
}
