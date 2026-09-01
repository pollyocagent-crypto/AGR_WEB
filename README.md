# AGR-WEB — AGR-117 Cloud Backend

Next.js 16 PWA + Supabase backend for remote access to AGR-117 HMI devices.

## Stack

- **Next.js 16** (App Router) + React 19 + TypeScript strict
- **Tailwind v4** + shadcn/ui + lucide-react + Base UI
- **next-intl** — EN/ES locales (matching HMI firmware)
- **Supabase** — Auth (magic link), Postgres + RLS, Realtime, Edge Functions
- **Cloudflare R2** — OTA firmware blobs
- **Resend** — Transactional email
- **Vercel** — Hosting (region `fra1`)

## Local development

```bash
npm install
cp .env.example .env.local    # fill in values
npm run dev                   # http://localhost:3000
npm run typecheck             # TypeScript strict check
npm run lint                  # ESLint
npm run format:check          # Prettier
npm run build                 # Production build
```

## Required environment variables

Copy `.env.example` → `.env.local` and fill in values.

| Variable                        | Description                                         |
| ------------------------------- | --------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL                                |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (public, safe in browser)         |
| `SUPABASE_SERVICE_ROLE_KEY`     | Service role key — **server-only, never expose**    |
| `SUPABASE_JWT_SECRET`           | JWT secret (must match Supabase project JWT secret) |
| `R2_ACCOUNT_ID`                 | Cloudflare account ID                               |
| `R2_ACCESS_KEY_ID`              | R2 API token access key                             |
| `R2_SECRET_ACCESS_KEY`          | R2 API token secret key                             |
| `R2_BUCKET_NAME`                | R2 bucket for OTA firmware blobs                    |
| `RESEND_API_KEY`                | Resend API key for transactional email              |
| `RESEND_FROM_EMAIL`             | Sender address for magic links / alerts             |

## Supabase Edge Functions

| Function           | Path                                   | Description                    |
| ------------------ | -------------------------------------- | ------------------------------ |
| `device-relay`     | `wss://…/functions/v1/device-relay`    | WSS endpoint for ESP32 devices |
| `device-bootstrap` | `POST …/functions/v1/device-bootstrap` | First-boot device registration |

See [`docs/device-relay-protocol.md`](docs/device-relay-protocol.md) for the full firmware client protocol.

## Deploy Edge Functions

```bash
supabase link --project-ref <project-ref>
supabase functions deploy device-relay
supabase functions deploy device-bootstrap
```

## Migrations

```bash
supabase db push
```

## Local development

```bash
supabase start
npm run dev
```

## Keeping the Supabase project awake

On the free tier Supabase pauses a project after ~7 days without API activity. A
paused project stops resolving in DNS, which takes down auth, Realtime, the
`device-relay` WSS endpoint and every `/api/devices/*` route — the Vercel site
still serves HTML, so the outage is silent (AGR-273).

Two independent cron legs ping the project, on two different providers, so that
neither provider going quiet can take the protection down (AGR-284).

### Leg 1 — GitHub Actions, every 3 days

`.github/workflows/supabase-keepalive.yml` pings PostgREST every 3 days. When the
ping fails it opens a GitHub issue labelled `supabase-outage` (and comments on the
existing one instead of opening duplicates), then fails the run — so the outage
arrives as both a notification and a ticket, which is the only signal there will
be. The next healthy run closes the issue again. The job needs two repository
secrets:

| Secret                        | Value                           |
| ----------------------------- | ------------------------------- |
| `SUPABASE_KEEPALIVE_URL`      | `NEXT_PUBLIC_SUPABASE_URL`      |
| `SUPABASE_KEEPALIVE_ANON_KEY` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

### Leg 2 — Vercel cron, daily

GitHub disables scheduled workflows in a public repository after 60 days without
repository activity, and the docs do not define what counts as activity — so leg 1
switches itself off exactly when the project goes quiet, which is also when nobody
is watching. (The popular workaround of committing a timestamp on a schedule is
not an option: `gautamkrishnar/keepalive-workflow`, which does that, was disabled
by GitHub for a terms-of-service violation.)

So `vercel.json` runs a second daily cron, `GET /api/cron/keepalive`
(`src/app/api/cron/keepalive/route.ts`), which performs the same anon PostgREST
read from a Vercel Function. Vercel documents no inactivity rule for cron jobs —
"New deployments do not affect existing cron jobs" — and Hobby allows 100 crons at
a minimum interval of once per day, so a daily ping is inside the free tier and
inside the ~7 day pause window. The route needs no new secrets beyond the ones the
app already has; production additionally sets:

| Variable      | Purpose                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `CRON_SECRET` | Vercel sends it as `Authorization: Bearer …`; the route rejects anything else. |

#### Alarm channels on leg 2

Pinging is only half the job: a leg that wakes the project but cannot say so when
waking fails is a silent failure (AGR-286). The route therefore has two
independent, individually optional alarm channels, and reports which ones are
live as `armed` in **every** response, healthy runs included — so a missing
credential is visible without waiting for an outage.

| Channel  | Variables                                                      | Behaviour                                                                                             |
| -------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `github` | `KEEPALIVE_GITHUB_TOKEN`, `KEEPALIVE_GITHUB_REPO`              | Opens/comments on the same `supabase-outage` issue leg 1 uses, and closes it on the next healthy run. |
| `email`  | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `KEEPALIVE_ALERT_EMAIL` | Sends the outage mail over Resend. Touches neither GitHub nor Supabase.                               |

The `github` channel needs a **fine-grained PAT scoped to this repository with
Issues: read and write** — nothing else. This keeps the two legs decoupled
despite sharing a ticket: GitHub disables the scheduled _workflow_ after 60 days
of repository silence, it does not disable the REST API, so leg 2 can still speak
after leg 1 has switched itself off.

A channel with missing variables is skipped, never fatal — an alarm failure must
not take the ping down with it. With no channel armed the run still records the
reason in its own JSON response and in the Vercel function logs, which is the
"silent but recorded" state to stay out of in production. Verify a leg-2 run
with:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://agr-hmi-cloud.vercel.app/api/cron/keepalive
# {"ok":true,"attempts":1,"checkedAt":"…","armed":["github"]}
# armed:[] ⇒ the ping is green but an outage would go unannounced.
```

### Restoring a paused project

A project that is already paused can be restored without dashboard access via the
Management API (`POST /v1/projects/{ref}/restore` with a personal access token;
the request needs an explicit `User-Agent` header or Cloudflare answers 403).
Restore takes a couple of minutes, after which re-run the workflow to confirm
(AGR-276).

The board reviewed the tier on 2026-09-01 (AGR-273) and chose to stay on the free
plan with this keep-alive, with one standing gate: **revisit Supabase Pro before
devices are handed to real users** — the free plan has no SLA against pausing and
no backups older than 7 days.

> **Residual gap — detection, not prevention.** Two legs on two providers keep the
> project awake, but both alarms live on infrastructure we own: if Vercel itself
> is the thing that breaks, or every leg-2 channel is unarmed while the Actions
> cron is disabled, an outage can still go unannounced. Closing that needs a third-party
> uptime monitor pointed at `/api/cron/keepalive`, which needs a board decision on
> an external account. Tracked on AGR-284, to be taken together with the standing
> "revisit Supabase Pro before devices reach real users" gate.
