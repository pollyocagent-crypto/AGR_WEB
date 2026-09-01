import { NextResponse } from "next/server";

/**
 * Second, GitHub-independent leg of the Supabase keep-alive (AGR-284).
 *
 * The first leg is `.github/workflows/supabase-keepalive.yml` (AGR-273). GitHub
 * disables scheduled workflows in a public repository after 60 days without
 * repository activity, so that leg switches itself off exactly when the project
 * goes quiet — which is also when nobody is watching. Vercel documents no such
 * rule ("New deployments do not affect existing cron jobs"), so a daily Vercel
 * cron on this route keeps pinging Postgres even if the Actions cron is dead.
 *
 * The ping is the same real PostgREST read the workflow does: it goes through
 * PostgREST to Postgres and therefore counts as project activity. RLS denies
 * anon, so an empty result set is the success case.
 */

// Cron invocations must reach the function, never a cached response.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pingPostgrest(url: string, anonKey: string) {
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${url}/rest/v1/devices?select=id&limit=1`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        cache: "no-store",
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true as const, attempts: attempt };
      lastStatus = res.status;
      lastBody = (await res.text()).slice(0, 400);
    } catch (err) {
      // A paused project stops resolving in DNS, so this is the usual failure.
      lastStatus = 0;
      lastBody = err instanceof Error ? err.message : String(err);
    }
    if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  return { ok: false as const, attempts: ATTEMPTS, status: lastStatus, detail: lastBody };
}

/**
 * Alert over a path that does not touch GitHub. Optional: without a Resend key
 * and a recipient the run still reports the outage in its own response body and
 * in the Vercel function logs, so it degrades to "silent but recorded" instead
 * of failing the ping itself.
 */
async function sendAlert(reason: string): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.KEEPALIVE_ALERT_EMAIL;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !to || !from)
    return "skipped: RESEND_API_KEY / KEEPALIVE_ALERT_EMAIL / RESEND_FROM_EMAIL not set";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        subject: "AGR-117 cloud: Supabase unreachable",
        text:
          `${reason}\n\n` +
          "The AGR-117 cloud backend (auth, Realtime, device-relay WSS, OTA) is down while " +
          "Vercel keeps serving the static shell, so nothing else will report this.\n" +
          "Restore a paused project with POST /v1/projects/{ref}/restore on the Supabase " +
          "Management API (PAT + explicit User-Agent header) — see README, " +
          "'Keeping the Supabase project awake'.\n\n" +
          "Sent by the Vercel cron keep-alive (AGR-284).",
      }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    return res.ok ? "sent" : `failed: HTTP ${res.status}`;
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function GET(request: Request) {
  // Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations when
  // the env var exists. Without the var the route stays open — it only performs
  // an anon read — but production sets it.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    const reason =
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing in the deployment.";
    console.error(`keepalive: ${reason}`);
    return NextResponse.json(
      { ok: false, reason, alert: await sendAlert(reason) },
      { status: 503 }
    );
  }

  const result = await pingPostgrest(url, anonKey);
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      attempts: result.attempts,
      checkedAt: new Date().toISOString(),
    });
  }

  const reason =
    result.status > 0
      ? `PostgREST answered HTTP ${result.status} on ${result.attempts} attempts: ${result.detail}`
      : `PostgREST unreachable on ${result.attempts} attempts (the project is most likely PAUSED): ${result.detail}`;
  console.error(`keepalive: ${reason}`);

  return NextResponse.json({ ok: false, reason, alert: await sendAlert(reason) }, { status: 503 });
}
