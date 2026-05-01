import { createClient } from "@/lib/supabase/server";
import { redirect as nextRedirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { DeviceList, type DeviceWithState } from "@/components/devices/device-list";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("devices");
  return { title: t("title") };
}

export default async function DevicesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) nextRedirect("/login");

  const t = await getTranslations("devices");
  const ta = await getTranslations("addDevice");

  const { data: ownerships } = await supabase.from("device_owners").select("device_id");
  const deviceIds = ownerships?.map((o) => o.device_id) ?? [];

  let initialDevices: DeviceWithState[] = [];

  if (deviceIds.length > 0) {
    const [{ data: devicesData }, { data: statesData }] = await Promise.all([
      supabase
        .from("devices")
        .select("id, device_uid, firmware_version, last_seen_at")
        .in("id", deviceIds)
        .order("created_at", { ascending: false }),
      supabase
        .from("device_state")
        .select("device_id, state, updated_at")
        .in("device_id", deviceIds),
    ]);

    const stateMap = new Map(
      (statesData ?? []).map((s) => [s.device_id, { state: s.state, updated_at: s.updated_at }])
    );

    initialDevices = (devicesData ?? []).map((d) => ({
      id: d.id,
      device_uid: d.device_uid,
      firmware_version: d.firmware_version,
      last_seen_at: d.last_seen_at,
      device_state: stateMap.get(d.id) ?? null,
    }));
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <Link
          href="/devices/add"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {ta("addDeviceButton")}
        </Link>
      </div>
      <DeviceList initialDevices={initialDevices} />
    </main>
  );
}
