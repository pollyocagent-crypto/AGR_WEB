"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";

export function ChangePasswordButton() {
  const t = useTranslations("profile");
  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError(t("passwordShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("passwordMismatch"));
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.updateUser({ password: newPassword });
    setLoading(false);

    if (authError) {
      setError(authError.message);
    } else {
      setSuccess(true);
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => {
        setOpen(false);
        setSuccess(false);
      }, 1500);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setError(null);
          setSuccess(false);
        }}
        className="rounded-lg border border-border px-4 py-2 text-sm font-semibold transition-colors hover:bg-secondary"
      >
        {t("changePassword")}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
            <h2 className="mb-4 text-lg font-semibold">{t("changePassword")}</h2>

            {success ? (
              <p className="text-sm text-green-600">{t("passwordChanged")}</p>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div>
                  <label htmlFor="new-password" className="mb-1 block text-sm font-medium">
                    {t("newPassword")}
                  </label>
                  <input
                    id="new-password"
                    type="password"
                    required
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label htmlFor="confirm-password" className="mb-1 block text-sm font-medium">
                    {t("confirmPassword")}
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    required
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                {error && (
                  <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {loading ? t("saving") : t("savePassword")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded-lg border border-border px-4 py-2 text-sm font-semibold transition-colors hover:bg-secondary"
                  >
                    ✕
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
