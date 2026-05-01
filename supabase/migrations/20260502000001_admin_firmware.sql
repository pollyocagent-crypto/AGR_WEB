-- =============================================================================
-- Migration: admin_firmware
-- AGR-125: admin_users whitelist + is_active flag on firmware_releases
-- =============================================================================

-- is_active flag — only one row should be true at a time (enforced in app)
alter table public.firmware_releases
  add column if not exists is_active boolean not null default false;

-- =============================================================================
-- ADMIN_USERS — email whitelist for /admin pages
-- =============================================================================
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);

comment on table public.admin_users is 'Email whitelist for admin access. Managed via service_role only.';

alter table public.admin_users enable row level security;

-- No SELECT policy for regular users — all admin checks use service_role client.
-- service_role bypasses RLS by default in Supabase.
