import { useTranslations } from "next-intl";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Devices" };

export default function DevicesPage() {
  const t = useTranslations("devices");

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-3xl font-bold">{t("title")}</h1>

      <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
        {t("empty")}
        <p className="mt-2 text-sm">Device list coming in AGR-123 (Realtime + device pairing).</p>
      </div>
    </main>
  );
}
