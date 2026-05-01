import { useTranslations } from "next-intl";
import Link from "next/link";

export default function LandingPage() {
  const t = useTranslations("landing");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="mx-auto max-w-2xl text-center">
        <div className="mb-8 flex justify-center">
          <span className="rounded-full bg-primary/10 px-4 py-1 text-sm font-medium text-primary">
            AGR-117
          </span>
        </div>

        <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">{t("headline")}</h1>

        <p className="mb-8 text-lg text-muted-foreground">{t("subheadline")}</p>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            {t("cta")}
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-lg border border-border px-6 py-3 font-semibold transition-colors hover:bg-secondary"
          >
            {t("ctaCreate")}
          </Link>
        </div>
      </div>
    </main>
  );
}
