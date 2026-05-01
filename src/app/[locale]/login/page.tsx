import { useTranslations } from "next-intl";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sign In" };

export default function LoginPage() {
  const t = useTranslations("login");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm">
        <h1 className="mb-6 text-2xl font-bold">{t("title")}</h1>

        <div className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
          Authentication coming in AGR-122 (Supabase Auth + magic link).
        </div>
      </div>
    </main>
  );
}
