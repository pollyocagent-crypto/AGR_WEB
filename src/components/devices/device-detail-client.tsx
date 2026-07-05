"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, ExternalLink, Loader2, Plug, RotateCw, WifiOff, Zap } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { createClient } from "@/lib/supabase/client";
import type { ChannelKind, Device, DeviceChannel, DeviceState, Json } from "@/lib/supabase/types";

type ChannelMeta = Pick<
  DeviceChannel,
  "kind" | "channel_index" | "label" | "motor_type" | "latching"
>;

// Live per-channel value carried in device_state. Legacy GEN-1 firmware omits
// `kind` (solenoid implied); GEN-2 tags each entry with its kind.
interface StateChannel {
  kind?: ChannelKind;
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
  channels?: StateChannel[];
  programs?: ProgramInfo[];
}

function parseState(state: Json | null): DeviceStateShape {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  return state as unknown as DeviceStateShape;
}

// key a live value by kind+index so solenoid #1 and motor_line #1 never collide
function stateKey(kind: ChannelKind, index: number): string {
  return `${kind}:${index}`;
}

function buildLiveMap(shape: DeviceStateShape): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const c of shape.channels ?? []) {
    m.set(stateKey(c.kind ?? "solenoid", c.index), !!c.active);
  }
  return m;
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
  device: Pick<Device, "id" | "device_uid" | "firmware_version" | "hw_model" | "last_seen_at">;
  initialState: Pick<DeviceState, "state" | "updated_at"> | null;
  channels: ChannelMeta[];
}

export function DeviceDetailClient({ device, initialState, channels }: Props) {
  const t = useTranslations("deviceDetail");
  const router = useRouter();
  const [rawState, setRawState] = useState(initialState?.state ?? null);
  const [lastSeenAt, setLastSeenAt] = useState(device.last_seen_at);
  // pending flags keyed by `${kind}:${index}` (or legacy numeric index as `solenoid:n`)
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [rescanPending, setRescanPending] = useState(false);
  const [otaPending, setOtaPending] = useState(false);
  const [otaMessage, setOtaMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const online = isOnline(lastSeenAt);
  const parsed = parseState(rawState);
  const liveMap = buildLiveMap(parsed);

  // GEN-2+ devices self-describe their I/O via HELLO → device_channels.
  const solenoids = channels
    .filter((c) => c.kind === "solenoid")
    .sort((a, b) => a.channel_index - b.channel_index);
  const motorLines = channels
    .filter((c) => c.kind === "motor_line")
    .sort((a, b) => a.channel_index - b.channel_index);
  const selfDescribed = channels.length > 0;

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
          // Clear pending flags for channels the device has now reported back.
          const next = buildLiveMap(parseState(n.state));
          setPending((prev) => {
            const remaining = new Set(prev);
            for (const key of next.keys()) remaining.delete(key);
            return remaining;
          });
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

  // Toggle a self-described channel (solenoid or motor line).
  const handleToggle = useCallback(
    async (kind: ChannelKind, index: number, newActive: boolean) => {
      if (!online) return;
      const key = stateKey(kind, index);
      setPending((prev) => new Set(prev).add(key));
      await sendCommand({
        type: "set_channel",
        kind,
        index,
        active: newActive,
      } as unknown as Json);
    },
    [online, sendCommand]
  );

  // Legacy GEN-1 fallback path — solenoid-only, no kind on the wire.
  const handleLegacyToggle = useCallback(
    async (index: number, newActive: boolean) => {
      if (!online) return;
      setPending((prev) => new Set(prev).add(stateKey("solenoid", index)));
      await sendCommand({ type: "set_channel", channel: index, active: newActive } as Json);
    },
    [online, sendCommand]
  );

  const handleRescan = useCallback(async () => {
    if (!online || rescanPending) return;
    setRescanPending(true);
    await sendCommand({ type: "rescan" } as Json);
    setTimeout(() => setRescanPending(false), 3000);
  }, [online, rescanPending, sendCommand]);

  const handleOta = useCallback(async () => {
    if (!online || otaPending) return;
    setOtaPending(true);
    setOtaMessage(null);
    try {
      const res = await fetch(`/api/devices/${device.id}/ota`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "OTA failed");
      setOtaMessage({ kind: "ok", text: t("otaSent", { version: json.version }) });
    } catch (err) {
      setOtaMessage({ kind: "err", text: err instanceof Error ? err.message : t("otaError") });
    } finally {
      setOtaPending(false);
    }
  }, [online, otaPending, device.id, t]);

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

      {/* Full device interface link */}
      <button
        onClick={() => router.push(`/devices/${device.id}/ui`)}
        className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-6 py-4 shadow-sm transition-colors hover:bg-secondary/50"
      >
        <div>
          <p className="text-left text-sm font-semibold">{t("fullInterfaceTitle")}</p>
          <p className="text-left text-xs text-muted-foreground">{t("fullInterfaceHint")}</p>
        </div>
        <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {selfDescribed ? (
        <>
          {/* Solenoid valves */}
          {solenoids.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold">{t("solenoids")}</h2>
                  <span className="text-xs text-muted-foreground">({solenoids.length})</span>
                </div>
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {solenoids.map((c) => {
                  const key = stateKey("solenoid", c.channel_index);
                  const active = liveMap.get(key) ?? false;
                  const label = c.label ?? t("valve", { n: c.channel_index });
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-3 py-2"
                    >
                      <span className="truncate pr-2 text-sm font-medium">{label}</span>
                      <Toggle
                        checked={active}
                        onChange={(val) => handleToggle("solenoid", c.channel_index, val)}
                        disabled={!online || pending.has(key)}
                        label={label}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Motor lines — isolated dry contacts, visually distinct from solenoids */}
          {motorLines.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="mb-1 flex items-center gap-2">
                <Plug className="h-5 w-5 text-amber-500" />
                <h2 className="text-lg font-semibold">{t("motorLines")}</h2>
              </div>
              <p className="mb-4 text-xs text-muted-foreground">{t("motorLinesHint")}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {motorLines.map((c) => {
                  const key = stateKey("motor_line", c.channel_index);
                  const active = liveMap.get(key) ?? false;
                  const label = c.label ?? t("line", { n: c.channel_index });
                  const badge = c.motor_type === "ac" ? t("motorAc") : t("motorDc");
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between rounded-lg border border-l-4 border-border border-l-amber-500 bg-secondary/30 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{label}</span>
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                            {badge}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {active ? t("lineClosed") : t("lineOpen")}
                        </span>
                      </div>
                      <Toggle
                        checked={active}
                        onChange={(val) => handleToggle("motor_line", c.channel_index, val)}
                        disabled={!online || pending.has(key)}
                        label={label}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      ) : (
        /* Legacy fallback: device has not sent HELLO — show 8 solenoid channels. */
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
                const key = stateKey("solenoid", n);
                const active = liveMap.get(key) ?? false;
                const label = t("channel", { n });
                return (
                  <div
                    key={n}
                    className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-3 py-2"
                  >
                    <span className="text-sm font-medium">{label}</span>
                    <Toggle
                      checked={active}
                      onChange={(val) => handleLegacyToggle(n, val)}
                      disabled={!online || pending.has(key)}
                      label={label}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

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

      {/* OTA */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t("otaTitle")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("otaHint")}</p>
          </div>
          <button
            onClick={handleOta}
            disabled={!online || otaPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {otaPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {otaPending ? t("otaSending") : t("otaButton")}
          </button>
        </div>
        {otaMessage && (
          <p
            className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
              otaMessage.kind === "ok"
                ? "border-green-200 bg-green-50 text-green-700 dark:border-green-800/40 dark:bg-green-900/20 dark:text-green-400"
                : "border-red-200 bg-red-50 text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400"
            }`}
          >
            {otaMessage.text}
          </p>
        )}
      </div>
    </div>
  );
}
