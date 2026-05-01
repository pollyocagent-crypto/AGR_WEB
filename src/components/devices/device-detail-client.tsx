"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { RotateCw, WifiOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { Device, DeviceState, Json } from "@/lib/supabase/types";

interface ChannelInfo {
  index: number;
  active: boolean;
  name?: string;
}

interface ProgramInfo {
  id: number;
  name?: string;
  active: boolean;
}

interface DeviceStateShape {
  channels?: ChannelInfo[];
  programs?: ProgramInfo[];
}

function parseState(state: Json | null): DeviceStateShape {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  return state as unknown as DeviceStateShape;
}

function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < 90_000;
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

interface Props {
  device: Pick<Device, "id" | "device_uid" | "firmware_version" | "last_seen_at">;
  initialState: Pick<DeviceState, "state" | "updated_at"> | null;
}

export function DeviceDetailClient({ device, initialState }: Props) {
  const t = useTranslations("deviceDetail");
  const [rawState, setRawState] = useState(initialState?.state ?? null);
  const [lastSeenAt, setLastSeenAt] = useState(device.last_seen_at);
  const [pendingChannels, setPendingChannels] = useState<Set<number>>(new Set());
  const [rescanPending, setRescanPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const online = isOnline(lastSeenAt);
  const parsed = parseState(rawState);

  // Build channel map 1..8 with defaults
  const channelMap = new Map<number, boolean>();
  for (let i = 1; i <= 8; i++) channelMap.set(i, false);
  if (parsed.channels) {
    for (const ch of parsed.channels) {
      channelMap.set(ch.index, ch.active);
    }
  }

  useEffect(() => {
    const supabase = createClient();
    const ch = supabase
      .channel(`device-detail-${device.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "device_state",
          filter: `device_id=eq.${device.id}`,
        },
        (payload) => {
          const n = payload.new as { state: Json; updated_at: string };
          setRawState(n.state);
          // Clear pending flags for channels whose state has been acked
          const newParsed = parseState(n.state);
          if (newParsed.channels) {
            setPendingChannels((prev) => {
              const next = new Set(prev);
              for (const c of newParsed.channels!) next.delete(c.index);
              return next;
            });
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "devices",
          filter: `id=eq.${device.id}`,
        },
        (payload) => {
          const n = payload.new as { last_seen_at: string | null };
          setLastSeenAt(n.last_seen_at);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [device.id]);

  const sendCommand = useCallback(
    async (payload: Json) => {
      setError(null);
      const supabase = createClient();
      const { error: rpcError } = await supabase.rpc("request_command", {
        p_device_id: device.id,
        p_payload: payload,
      });
      if (rpcError) setError(t("commandError"));
    },
    [device.id, t]
  );

  const handleChannelToggle = useCallback(
    async (channelIndex: number, newActive: boolean) => {
      if (!online) return;
      setPendingChannels((prev) => new Set(prev).add(channelIndex));
      await sendCommand({
        type: "set_channel",
        channel: channelIndex,
        active: newActive,
      } as Json);
    },
    [online, sendCommand]
  );

  const handleRescan = useCallback(async () => {
    if (!online || rescanPending) return;
    setRescanPending(true);
    await sendCommand({ type: "rescan" } as Json);
    setTimeout(() => setRescanPending(false), 3000);
  }, [online, rescanPending, sendCommand]);

  return (
    <div className="space-y-6">
      {!online && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
          <WifiOff className="h-4 w-4 shrink-0" />
          {t("offlineBanner")}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Channels */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("channels")}</h2>
          <button
            onClick={handleRescan}
            disabled={!online || rescanPending}
            title={t("rescanHint")}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCw className={`h-4 w-4 ${rescanPending ? "animate-spin" : ""}`} />
            {rescanPending ? t("rescanning") : t("rescan")}
          </button>
        </div>

        {rawState === null ? (
          <p className="text-sm text-muted-foreground">{t("noChannels")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => {
              const active = channelMap.get(n) ?? false;
              const pending = pendingChannels.has(n);
              const label = t("channel", { n });
              return (
                <div
                  key={n}
                  className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-3 py-2"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <Toggle
                    checked={active}
                    onChange={(val) => handleChannelToggle(n, val)}
                    disabled={!online || pending}
                    label={label}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Programs (shown only when present in state) */}
      {parsed.programs && parsed.programs.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">{t("programs")}</h2>
          <div className="space-y-2">
            {parsed.programs.map((prog) => {
              const label = prog.name ?? t("program", { n: prog.id });
              return (
                <div
                  key={prog.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-3 py-2"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <Toggle
                    checked={prog.active}
                    onChange={(val) =>
                      sendCommand({ type: "set_program", program_id: prog.id, active: val } as Json)
                    }
                    disabled={!online}
                    label={label}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
