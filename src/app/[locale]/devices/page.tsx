import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Devices" };

export default async function DevicesPage() {
  const t = await getTranslations("devices");
  const ta = await getTranslations("addDevice");

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

      <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
        {t("empty")}
      </div>
    </main>
  );
}
