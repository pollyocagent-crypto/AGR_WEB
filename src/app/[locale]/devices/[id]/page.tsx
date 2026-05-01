import { createClient } from "@/lib/supabase/server";
import { redirect as nextRedirect } from "next/navigation";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DeviceDetailClient } from "@/components/devices/device-detail-client";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ locale: string; id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = await getTranslations("deviceDetail");
  return { title: `${t("title")} — ${id.slice(0, 8)}` };
}

export default async function DeviceDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) nextRedirect("/login");

  const t = await getTranslations("deviceDetail");

  // Verify ownership (RLS enforces this, but we want 404 over empty UI).
  const { data: ownership } = await supabase
    .from("device_owners")
    .select("role")
    .eq("device_id", id)
    .maybeSingle();

  if (!ownership) notFound();

  const [{ data: device }, { data: stateRow }] = await Promise.all([
    supabase
      .from("devices")
      .select("id, device_uid, firmware_version, last_seen_at")
      .eq("id", id)
      .single(),
    supabase.from("device_state").select("state, updated_at").eq("device_id", id).maybeSingle(),
  ]);

  if (!device) notFound();

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-1 text-3xl font-bold">{t("title")}</h1>
      <p className="mb-1 font-mono text-sm text-muted-foreground">{device.device_uid}</p>
      {device.firmware_version && (
        <p className="mb-6 text-xs text-muted-foreground">fw {device.firmware_version}</p>
      )}

      <DeviceDetailClient device={device} initialState={stateRow ?? null} />
    </main>
  );
}
