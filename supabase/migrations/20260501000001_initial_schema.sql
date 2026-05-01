-- =============================================================================
-- Migration: initial_schema
-- AGR-119: Core tables for AGR-117 cloud backend
-- =============================================================================

create extension if not exists "uuid-ossp";

-- =============================================================================
-- updated_at trigger helper
-- =============================================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- DEVICES — one row per physical HMI unit
-- =============================================================================
create table if not exists public.devices (
  id               uuid primary key default uuid_generate_v4(),
  device_uid       text not null unique,   -- factory UID burned into NVS
  firmware_version text,
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now()
);

comment on table public.devices is 'Physical HMI devices registered in the system.';

alter table public.devices enable row level security;

-- =============================================================================
-- DEVICE_OWNERS — user–device membership (owner / member)
-- =============================================================================
create type public.device_role as enum ('owner', 'member');

create table if not exists public.device_owners (
  device_id  uuid not null references public.devices(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.device_role not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (device_id, user_id)
);

comment on table public.device_owners is 'User–device ownership and role mapping.';
create index device_owners_user_id_idx on public.device_owners(user_id);

alter table public.device_owners enable row level security;

-- =============================================================================
-- DEVICE_STATE — latest telemetry snapshot per device
-- =============================================================================
create table if not exists public.device_state (
  device_id  uuid primary key references public.devices(id) on delete cascade,
  state      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

comment on table public.device_state is 'Latest state snapshot pushed by the device over WSS.';

alter table public.device_state enable row level security;

create trigger set_updated_at_device_state
  before update on public.device_state
  for each row execute function public.set_updated_at();

-- =============================================================================
-- DEVICE_COMMANDS — commands queued for devices
-- =============================================================================
create type public.command_status as enum ('pending', 'sent', 'acked', 'failed');

create table if not exists public.device_commands (
  id           uuid primary key default uuid_generate_v4(),
  device_id    uuid not null references public.devices(id) on delete cascade,
  payload      jsonb not null,
  requested_by uuid not null references auth.users(id) on delete restrict,
  status       public.command_status not null default 'pending',
  created_at   timestamptz not null default now(),
  acked_at     timestamptz
);

comment on table public.device_commands is 'Commands issued to devices; relayed over WSS by device-relay.';
create index device_commands_device_pending_idx
  on public.device_commands(device_id, status)
  where status = 'pending';

alter table public.device_commands enable row level security;

-- =============================================================================
-- PAIRING_CODES — short-lived 6-digit codes displayed on HMI QR
-- =============================================================================
create table if not exists public.pairing_codes (
  code       text primary key,             -- 6-digit numeric string
  device_id  uuid not null references public.devices(id) on delete cascade,
  expires_at timestamptz not null
);

comment on table public.pairing_codes is '6-digit one-time codes for QR pairing; TTL 1h.';
create index pairing_codes_device_id_idx  on public.pairing_codes(device_id);
create index pairing_codes_expires_idx    on public.pairing_codes(expires_at);

alter table public.pairing_codes enable row level security;

-- =============================================================================
-- DEVICE_EVENTS — audit log of boot/error events from devices
-- =============================================================================
create table if not exists public.device_events (
  id         uuid primary key default uuid_generate_v4(),
  device_id  uuid not null references public.devices(id) on delete cascade,
  kind       text not null,   -- 'boot' | 'error' | ...
  data       jsonb,
  ts         bigint,          -- epoch from device (seconds)
  created_at timestamptz not null default now()
);

comment on table public.device_events is 'Event log from devices (boot, error, custom).';
create index device_events_device_id_idx on public.device_events(device_id);
create index device_events_created_at_idx on public.device_events(created_at desc);

alter table public.device_events enable row level security;

-- =============================================================================
-- FIRMWARE_RELEASES — OTA release manifest (blobs in Cloudflare R2)
-- =============================================================================
create table if not exists public.firmware_releases (
  version      text primary key,
  r2_object_key text not null,
  sha256       text not null,
  notes        text,
  published_at timestamptz not null default now()
);

comment on table public.firmware_releases is 'OTA firmware release metadata; actual blobs in Cloudflare R2.';

alter table public.firmware_releases enable row level security;
