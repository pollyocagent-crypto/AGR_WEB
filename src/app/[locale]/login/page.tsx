"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "login" | "signup";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const t = useTranslations("login");
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/devices";

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  async function handleForgotPassword() {
    if (!EMAIL_RE.test(email)) {
      setError(t("errorEmail"));
      return;
    }
    setForgotLoading(true);
    setError(null);
    const supabase = createClient();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/reset`,
    });
    setForgotLoading(false);
    setForgotSent(true);
  }

  function validate(): string | null {
    if (!EMAIL_RE.test(email)) return t("errorEmail");
    if (password.length < 8) return t("errorPasswordLength");
    return null;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    const supabase = createClient();

    if (mode === "signup") {
      const { error: authError } = await supabase.auth.signUp({ email, password });
      setLoading(false);
      if (authError) {
        if (authError.message.toLowerCase().includes("already registered")) {
          setError(t("errorAlreadyExists"));
        } else {
          setError(authError.message);
        }
        return;
      }
    } else {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (authError) {
        setError(t("errorInvalidCredentials"));
        return;
      }
    }

    const safePath = next.startsWith("/") ? next : "/devices";
    router.push(safePath);
    router.refresh();
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm">
        <h1 className="mb-6 text-2xl font-bold">
          {mode === "login" ? t("titleLogin") : t("titleSignup")}
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium">
              {t("emailLabel")}
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("emailPlaceholder")}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium">
              {t("passwordLabel")}
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("passwordPlaceholder")}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {mode === "login" && (
              <div className="mt-1 flex justify-end">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={forgotLoading}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline disabled:opacity-50"
                >
                  {forgotLoading ? t("loading") : t("forgotPassword")}
                </button>
              </div>
            )}
          </div>

          {forgotSent && (
            <div className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
              {t("forgotSent")}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? t("loading") : mode === "login" ? t("submitLogin") : t("submitSignup")}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {mode === "login" ? t("noAccount") : t("haveAccount")}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setError(null);
            }}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {mode === "login" ? t("switchToSignup") : t("switchToLogin")}
          </button>
        </p>
      </div>
    </main>
  );
}
