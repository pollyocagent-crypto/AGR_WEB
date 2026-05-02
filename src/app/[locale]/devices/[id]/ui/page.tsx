import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChevronLeft } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ locale: string; id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = await getTranslations("deviceUi");
  return { title: `${t("title")} — ${id.slice(0, 8)}` };
}

export default async function DeviceUiPage({ params }: Props) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: ownership } = await supabase
    .from("device_owners")
    .select("role")
    .eq("device_id", id)
    .maybeSingle();
  if (!ownership) notFound();

  const t = await getTranslations("deviceUi");

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Minimal top bar — keeps navigation without wasting height */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <Link
          href={`/devices/${id}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          {t("back")}
        </Link>
        <span className="text-sm font-medium">{t("title")}</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{id.slice(0, 8)}</span>
      </div>

      {/* Full-height iframe — device's built-in web UI via /control (AGR-140/139) */}
      <iframe
        src={`/api/devices/${id}/control`}
        className="min-h-0 flex-1 w-full border-0"
        title={t("title")}
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
    </div>
  );
}
