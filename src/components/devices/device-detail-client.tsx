"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  ArrowRightLeft,
  Download,
  Droplets,
  ExternalLink,
  Loader2,
  RotateCw,
  WifiOff,
} from "lucide-react";
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
  // Wet-touch confirm: closing (energizing) a motor-line contact is gated behind
  // an explicit confirmation dialog — a wet capacitive screen can register phantom
  // taps, and we never close a (possibly mains) line on a stray touch (design §6).
  const [motorConfirm, setMotorConfirm] = useState<ChannelMeta | null>(null);

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

  // Motor lines: opening the contact (de-energize) is immediate; closing
  // (energize) is routed through the wet-touch confirmation dialog first.
  const requestMotorToggle = useCallback(
    (c: ChannelMeta, newActive: boolean) => {
      if (!online) return;
      if (newActive) {
        setMotorConfirm(c);
      } else {
        void handleToggle("motor_line", c.channel_index, false);
      }
    },
    [online, handleToggle]
  );

  const confirmMotorClose = useCallback(() => {
    if (!motorConfirm) return;
    void handleToggle("motor_line", motorConfirm.channel_index, true);
    setMotorConfirm(null);
  }, [motorConfirm, handleToggle]);

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
                  <Droplets className="h-5 w-5 text-primary" />
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

          {/* Motor lines — isolated dry contacts. Distinct visual language per
              the locked GEN-2 design: ⇄ commutation glyph, DC/AC badge, double
              amber border, contact verbs (open/closed) with a filled state dot. */}
          {motorLines.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="mb-1 flex items-center gap-2">
                <ArrowRightLeft className="h-5 w-5 text-amber-500" />
                <h2 className="text-lg font-semibold">{t("motorLines")}</h2>
              </div>
              <p className="mb-4 text-xs text-muted-foreground">{t("motorLinesHint")}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {motorLines.map((c) => {
                  const key = stateKey("motor_line", c.channel_index);
                  const active = liveMap.get(key) ?? false;
                  const label = c.label ?? t("line", { n: c.channel_index });
                  const isAc = c.motor_type === "ac";
                  const badge = isAc ? t("motorAc") : t("motorDc");
                  // State is shape + text + dot, never colour alone (outdoor legibility).
                  const verb = active ? t("contactClosed") : t("contactOpen");
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between rounded-lg border-2 border-amber-500/60 bg-secondary/30 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{label}</span>
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                            <ArrowRightLeft className="h-3 w-3" />
                            {badge}
                          </span>
                        </div>
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs">
                          <span
                            aria-hidden
                            className={`inline-block h-2 w-2 rounded-full ${
                              active ? "bg-amber-500" : "border border-muted-foreground/50"
                            }`}
                          />
                          <span
                            className={
                              active
                                ? "font-medium text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground"
                            }
                          >
                            {verb}
                          </span>
                          <span className="text-muted-foreground">· IN─┤⌁├─OUT</span>
                        </span>
                      </div>
                      <Toggle
                        checked={active}
                        onChange={(val) => requestMotorToggle(c, val)}
                        disabled={!online || pending.has(key)}
                        label={`${label} — ${verb}`}
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

      {/* Wet-touch confirmation — required before CLOSING (energizing) a motor
          line. Opening the contact is immediate; closing a possibly-mains line
          must never happen on a stray touch (design §6). */}
      {motorConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setMotorConfirm(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <h3 className="text-lg font-semibold">{t("wetConfirmTitle")}</h3>
            </div>
            <p className="mb-2 text-sm text-muted-foreground">
              {t("wetConfirmBody", {
                type: motorConfirm.motor_type === "ac" ? t("motorAc") : t("motorDc"),
              })}
            </p>
            {motorConfirm.motor_type === "ac" && (
              <p className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t("wetConfirmAcWarn")}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setMotorConfirm(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-secondary"
              >
                {t("wetConfirmCancel")}
              </button>
              <button
                onClick={confirmMotorClose}
                className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600"
              >
                <ArrowRightLeft className="h-4 w-4" />
                {t("wetConfirmClose")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
