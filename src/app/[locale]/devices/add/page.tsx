"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import type { IDetectedBarcode } from "@yudiel/react-qr-scanner";

// Lazy-load scanner: camera APIs are browser-only and fail during SSR
const Scanner = dynamic(() => import("@yudiel/react-qr-scanner").then((m) => m.Scanner), {
  ssr: false,
  loading: () => <div className="h-48 animate-pulse rounded-xl bg-muted" />,
});

type Tab = "type" | "scan";

function extractCode(raw: string): string {
  // QR may contain a URL with ?code= or just the bare 6-digit string
  try {
    const url = new URL(raw);
    const c = url.searchParams.get("code");
    if (c) return c.trim();
  } catch {
    // not a URL — use raw value
  }
  return raw.trim();
}

export default function AddDevicePage() {
  const t = useTranslations("addDevice");
  const router = useRouter();
  const searchParams = useSearchParams();

  const [tab, setTab] = useState<Tab>("type");
  const [code, setCode] = useState(() => {
    const raw = searchParams.get("code") ?? "";
    return raw
      .toUpperCase()
      .replace(/[^A-HJ-NP-Z2-9]/g, "")
      .slice(0, 6);
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannerActive, setScannerActive] = useState(false);

  const handleCodeInput = (val: string) => {
    setCode(
      val
        .toUpperCase()
        .replace(/[^A-HJ-NP-Z2-9]/g, "")
        .slice(0, 6)
    );
  };

  const pair = useCallback(
    async (pairingCode: string) => {
      if (pairingCode.length !== 6) return;
      setLoading(true);
      setError(null);

      const supabase = createClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: deviceId, error: rpcError } = await (supabase.rpc as any)("pair_device", {
        p_code: pairingCode,
      });

      setLoading(false);

      if (rpcError) {
        const msg: string = rpcError.message ?? "";
        if (msg.includes("invalid_code")) {
          setError(t("errorInvalid"));
        } else if (msg.includes("code_expired")) {
          setError(t("errorExpired"));
        } else if (msg.includes("already")) {
          setError(t("errorAlreadyPaired"));
        } else {
          setError(t("errorGeneric"));
        }
        return;
      }

      router.push(`/devices/${deviceId as string}`);
    },
    [router, t]
  );

  const handleScan = useCallback(
    (detectedCodes: IDetectedBarcode[]) => {
      const first = detectedCodes[0];
      if (!first) return;
      setScannerActive(false);
      const extracted = extractCode(first.rawValue)
        .toUpperCase()
        .replace(/[^A-HJ-NP-Z2-9]/g, "")
        .slice(0, 6);
      setCode(extracted);
      if (extracted.length === 6) {
        pair(extracted);
      } else {
        setTab("type");
        setError(t("errorInvalid"));
      }
    },
    [pair, t]
  );

  const handleScanError = useCallback(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("denied")) {
        setScannerActive(false);
        setTab("type");
        setError(t("errorCamera"));
      }
    },
    [t]
  );

  const switchTab = (next: Tab) => {
    setTab(next);
    setError(null);
    setScannerActive(next === "scan");
  };

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <h1 className="mb-2 text-3xl font-bold">{t("title")}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{t("subtitle")}</p>

      {/* Tab selector */}
      <div className="mb-6 flex gap-2 rounded-xl border border-border bg-muted p-1">
        {(["type", "scan"] as const).map((id) => (
          <button
            key={id}
            onClick={() => switchTab(id)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {id === "type" ? t("typeTab") : t("scanTab")}
          </button>
        ))}
      </div>

      {tab === "scan" ? (
        <div className="flex flex-col gap-4">
          <p className="text-center text-sm text-muted-foreground">{t("scanHint")}</p>
          {scannerActive && (
            <div className="overflow-hidden rounded-xl border border-border">
              <Scanner
                onScan={handleScan}
                onError={handleScanError}
                constraints={{ facingMode: "environment" }}
                formats={["qr_code"]}
                styles={{ container: { width: "100%" } }}
              />
            </div>
          )}
          {!scannerActive && (
            <button
              onClick={() => setScannerActive(true)}
              className="mx-auto rounded-lg border border-border px-6 py-2 text-sm font-medium transition-colors hover:bg-muted"
            >
              {t("scanTab")}
            </button>
          )}
          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            pair(code);
          }}
          className="flex flex-col gap-4"
        >
          <div>
            <label htmlFor="pairing-code" className="mb-1 block text-sm font-medium">
              {t("codeLabel")}
            </label>
            <input
              id="pairing-code"
              type="text"
              inputMode="text"
              pattern="[A-HJ-NP-Z2-9]{6}"
              autoCapitalize="characters"
              maxLength={6}
              required
              autoComplete="off"
              value={code}
              onChange={(e) => handleCodeInput(e.target.value)}
              placeholder={t("codePlaceholder")}
              className="w-full rounded-lg border border-border bg-background px-4 py-3 text-center font-mono text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || code.length !== 6}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? t("pairing") : t("submit")}
          </button>
        </form>
      )}
    </main>
  );
}
