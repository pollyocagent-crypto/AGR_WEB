import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";

interface Props {
  params: Promise<{ locale: string; id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Device ${id}` };
}

export default async function DeviceDetailPage({ params }: Props) {
  const { id } = await params;
  const t = await getTranslations("deviceDetail");

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-2 text-3xl font-bold">{t("title")}</h1>
      <p className="mb-6 font-mono text-sm text-muted-foreground">{id}</p>

      <div className="grid gap-4 sm:grid-cols-3">
        {(["state", "commands", "events"] as const).map((section) => (
          <div
            key={section}
            className="rounded-xl border border-border bg-card p-6 text-center text-muted-foreground"
          >
            <p className="font-semibold">{t(section)}</p>
            <p className="mt-1 text-xs">Coming in AGR-123</p>
          </div>
        ))}
      </div>
    </main>
  );
}
