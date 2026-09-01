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

const OUTAGE_LABEL = "supabase-outage";
const OUTAGE_TITLE = "Supabase backend unreachable — AGR-117 cloud is down";

const CONSEQUENCE =
  "The AGR-117 cloud backend (auth, Realtime, device-relay WSS, OTA) is down while " +
  "Vercel keeps serving the static shell, so nothing else will report this.\n" +
  "Restore a paused project with POST /v1/projects/{ref}/restore on the Supabase " +
  "Management API (PAT + explicit User-Agent header) — see README, " +
  "'Keeping the Supabase project awake'.";

/**
 * Which alarm channels this deployment can actually reach. Reported on every
 * run — including healthy ones — because the failure mode this route guards
 * against is an alarm nobody notices is unconfigured (AGR-286).
 */
function armedChannels(): string[] {
  const armed: string[] = [];
  if (process.env.KEEPALIVE_GITHUB_TOKEN && process.env.KEEPALIVE_GITHUB_REPO) armed.push("github");
  if (
    process.env.RESEND_API_KEY &&
    process.env.KEEPALIVE_ALERT_EMAIL &&
    process.env.RESEND_FROM_EMAIL
  )
    armed.push("email");
  return armed;
}

async function github(path: string, init?: RequestInit) {
  return fetch(`https://api.github.com/repos/${process.env.KEEPALIVE_GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.KEEPALIVE_GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      // The REST API rejects requests without one.
      "User-Agent": "agr-keepalive",
      ...init?.headers,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
}

/** Open `supabase-outage` issues, ignoring pull requests the same route returns. */
async function openOutageIssues(): Promise<number[]> {
  const res = await github(`/issues?labels=${OUTAGE_LABEL}&state=open&per_page=20`);
  if (!res.ok) throw new Error(`list issues: HTTP ${res.status}`);
  const issues = (await res.json()) as { number: number; pull_request?: unknown }[];
  return issues.filter((i) => !i.pull_request).map((i) => i.number);
}

/**
 * Raise the outage on the same GitHub ticket leg 1 uses. GitHub disables the
 * *scheduled workflow* after 60 days of repository silence, not the REST API, so
 * driving that channel from Vercel keeps the two legs decoupled while giving
 * them one place to look (AGR-286). Needs a fine-grained PAT with Issues: write
 * on this repository only.
 */
async function alertGitHub(reason: string): Promise<string> {
  if (!process.env.KEEPALIVE_GITHUB_TOKEN || !process.env.KEEPALIVE_GITHUB_REPO)
    return "skipped: KEEPALIVE_GITHUB_TOKEN / KEEPALIVE_GITHUB_REPO not set";

  const body = `${reason}\n\nRaised automatically by the Vercel cron keep-alive (AGR-284), \`GET /api/cron/keepalive\`.\n${CONSEQUENCE}\n\nThis issue is closed automatically by the next healthy run of either leg.`;

  try {
    const [existing] = await openOutageIssues();
    if (existing) {
      const res = await github(`/issues/${existing}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      return res.ok ? `commented on #${existing}` : `failed: comment HTTP ${res.status}`;
    }

    const res = await github("/issues", {
      method: "POST",
      body: JSON.stringify({ title: OUTAGE_TITLE, body, labels: [OUTAGE_LABEL] }),
    });
    if (!res.ok) return `failed: create HTTP ${res.status}`;
    const created = (await res.json()) as { number: number };
    return `opened #${created.number}`;
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Close the outage ticket once the ping is green again. Leg 1 does the same, but
 * it may be the dead leg — without this the ticket would outlive the outage.
 */
async function resolveGitHub(): Promise<string | undefined> {
  if (!process.env.KEEPALIVE_GITHUB_TOKEN || !process.env.KEEPALIVE_GITHUB_REPO) return undefined;

  try {
    const open = await openOutageIssues();
    if (open.length === 0) return undefined;

    for (const number of open) {
      await github(`/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({
          body: "Keep-alive is green again — PostgREST answered 2xx. Closed by the Vercel cron leg (AGR-284).",
        }),
      });
      await github(`/issues/${number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      });
    }
    return `closed ${open.map((n) => `#${n}`).join(", ")}`;
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Alert over a path that does not touch GitHub at all. */
async function alertEmail(reason: string): Promise<string> {
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
        text: `${reason}\n\n${CONSEQUENCE}\n\nSent by the Vercel cron keep-alive (AGR-284).`,
      }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    return res.ok ? "sent" : `failed: HTTP ${res.status}`;
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Every channel is optional and they are independent, so one missing credential
 * cannot silence the others and an alarm failure never fails the ping itself.
 * With nothing configured the run still records the outage in its own response
 * and in the Vercel function logs — "silent but recorded", which is the state
 * AGR-286 exists to get out of.
 */
async function raiseAlerts(reason: string) {
  const [gh, email] = await Promise.all([alertGitHub(reason), alertEmail(reason)]);
  return { github: gh, email };
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
      { ok: false, reason, armed: armedChannels(), alerts: await raiseAlerts(reason) },
      { status: 503 }
    );
  }

  const result = await pingPostgrest(url, anonKey);
  if (result.ok) {
    const armed = armedChannels();
    if (armed.length === 0)
      console.warn("keepalive: ping is green but no alarm channel is configured (AGR-286)");
    return NextResponse.json({
      ok: true,
      attempts: result.attempts,
      checkedAt: new Date().toISOString(),
      armed,
      resolved: await resolveGitHub(),
    });
  }

  const reason =
    result.status > 0
      ? `PostgREST answered HTTP ${result.status} on ${result.attempts} attempts: ${result.detail}`
      : `PostgREST unreachable on ${result.attempts} attempts (the project is most likely PAUSED): ${result.detail}`;
  console.error(`keepalive: ${reason}`);

  return NextResponse.json(
    { ok: false, reason, armed: armedChannels(), alerts: await raiseAlerts(reason) },
    { status: 503 }
  );
}
