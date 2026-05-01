"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Wifi, WifiOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { Device, DeviceState, Json } from "@/lib/supabase/types";

export type DeviceWithState = Pick<
  Device,
  "id" | "device_uid" | "firmware_version" | "last_seen_at"
> & {
  device_state: Pick<DeviceState, "state" | "updated_at"> | null;
};

function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < 90_000;
}

function getActiveChannelCount(state: Json | null): number {
  if (!state || typeof state !== "object" || Array.isArray(state)) return 0;
  const channels = (state as Record<string, unknown>).channels as
    | Array<{ active?: boolean }>
    | undefined;
  if (!Array.isArray(channels)) return 0;
  return channels.filter((c) => c.active).length;
}

export function DeviceList({ initialDevices }: { initialDevices: DeviceWithState[] }) {
  const t = useTranslations("devices");
  const [devices, setDevices] = useState(initialDevices);

  useEffect(() => {
    if (initialDevices.length === 0) return;
    const supabase = createClient();
    const ids = initialDevices.map((d) => d.id).join(",");

    const ch = supabase
      .channel("device-list")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "device_state",
          filter: `device_id=in.(${ids})`,
        },
        (payload) => {
          const n = payload.new as { device_id: string; state: Json; updated_at: string };
          setDevices((prev) =>
            prev.map((d) =>
              d.id === n.device_id
                ? { ...d, device_state: { state: n.state, updated_at: n.updated_at } }
                : d
            )
          );
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "devices",
          filter: `id=in.(${ids})`,
        },
        (payload) => {
          const n = payload.new as { id: string; last_seen_at: string | null };
          setDevices((prev) =>
            prev.map((d) => (d.id === n.id ? { ...d, last_seen_at: n.last_seen_at } : d))
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (devices.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
        {t("empty")}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {devices.map((device) => {
        const online = isOnline(device.last_seen_at);
        const state = device.device_state?.state ?? null;
        const activeChannels = getActiveChannelCount(state);

        return (
          <Link
            key={device.id}
            href={`/devices/${device.id}`}
            className={`block rounded-xl border p-5 shadow-sm transition-colors hover:bg-secondary/50 ${
              online ? "border-border bg-card" : "border-border bg-card opacity-60"
            }`}
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-semibold">{device.device_uid}</p>
                {device.firmware_version && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("firmware")}: {device.firmware_version}
                  </p>
                )}
              </div>
              <span
                className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                  online
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {online ? (
                  <>
                    <Wifi className="h-3 w-3" />
                    {t("online")}
                  </>
                ) : (
                  <>
                    <WifiOff className="h-3 w-3" />
                    {t("offline")}
                  </>
                )}
              </span>
            </div>

            <p className="text-sm text-muted-foreground">
              {state !== null ? t("activeChannels", { count: activeChannels }) : t("noState")}
            </p>

            {device.last_seen_at && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("lastSeen")}:{" "}
                <time dateTime={device.last_seen_at}>
                  {new Date(device.last_seen_at).toLocaleString()}
                </time>
              </p>
            )}
          </Link>
        );
      })}
    </div>
  );
}
