"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, CheckCircle, Loader2 } from "lucide-react";
import type { FirmwareRelease } from "@/lib/supabase/types";

interface Props {
  initialReleases: Pick<
    FirmwareRelease,
    "version" | "sha256" | "notes" | "published_at" | "is_active"
  >[];
}

export function FirmwareManager({ initialReleases }: Props) {
  const [releases, setReleases] = useState(initialReleases);
  const [uploading, setUploading] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const versionRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const handleUpload = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError(null);
    setUploadSuccess(null);

    const file = fileRef.current?.files?.[0];
    const version = versionRef.current?.value.trim();

    if (!file || !version) {
      setUploadError("File and version are required.");
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      setUploadError("File too large (max 8 MB).");
      return;
    }

    const fd = new FormData();
    fd.append("file", file);
    fd.append("version", version);
    const notes = notesRef.current?.value.trim();
    if (notes) fd.append("notes", notes);

    setUploading(true);
    try {
      const res = await fetch("/api/admin/firmware/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setUploadSuccess(`Uploaded v${version} — SHA256: ${json.sha256.slice(0, 12)}…`);
      // Refresh list
      setReleases((prev) => [
        {
          version,
          sha256: json.sha256,
          notes: notes || null,
          published_at: new Date().toISOString(),
          is_active: false,
        },
        ...prev,
      ]);
      if (fileRef.current) fileRef.current.value = "";
      if (versionRef.current) versionRef.current.value = "";
      if (notesRef.current) notesRef.current.value = "";
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, []);

  const handleActivate = useCallback(async (version: string) => {
    setActivating(version);
    try {
      const res = await fetch("/api/admin/firmware/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.error ?? "Activate failed");
      }
      setReleases((prev) => prev.map((r) => ({ ...r, is_active: r.version === version })));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to activate");
    } finally {
      setActivating(null);
    }
  }, []);

  return (
    <div className="space-y-8">
      {/* Upload Form */}
      <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold">Upload New Release</h2>
        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Firmware .bin file</label>
            <input
              ref={fileRef}
              type="file"
              accept=".bin"
              required
              className="block w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Version</label>
            <input
              ref={versionRef}
              type="text"
              placeholder="e.g. 1.3.0"
              required
              pattern="[\w.\-]+"
              className="block w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Release notes (optional)</label>
            <textarea
              ref={notesRef}
              rows={3}
              placeholder="What changed in this release…"
              className="block w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
          </div>

          {uploadError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400">
              {uploadError}
            </p>
          )}
          {uploadSuccess && (
            <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800/40 dark:bg-green-900/20 dark:text-green-400">
              {uploadSuccess}
            </p>
          )}

          <button
            type="submit"
            disabled={uploading}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </form>
      </section>

      {/* Release List */}
      <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold">Releases</h2>
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No firmware releases yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {releases.map((r) => (
              <div key={r.version} className="flex items-start justify-between gap-4 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">v{r.version}</span>
                    {r.is_active && (
                      <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        <CheckCircle className="h-3 w-3" />
                        Active
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    SHA256: {r.sha256.slice(0, 16)}…
                  </p>
                  {r.notes && <p className="mt-1 text-xs text-muted-foreground">{r.notes}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(r.published_at).toLocaleString()}
                  </p>
                </div>
                {!r.is_active && (
                  <button
                    onClick={() => handleActivate(r.version)}
                    disabled={activating === r.version}
                    className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {activating === r.version ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Make Active"
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
