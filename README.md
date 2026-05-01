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
