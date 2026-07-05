-- =============================================================================
-- Migration: gen2_channel_model
-- AGR-197: Port cloud data model to GEN-2 device I/O.
--
-- GEN-2 I/O model (authoritative — AGR-194 architecture doc):
--   * 16 solenoid channels — active latching drivers (BERMAD S-985, 3-wire
--     latching; bipolar impulse to open/close, zero holding current).
--   * 2 motor-line outputs — galvanically-isolated DRY CONTACTS. The module
--     sources zero load current; it only makes/breaks an external line.
--       - motor line 1: DC motor via opto-isolated MOSFET SSR
--       - motor line 2: AC motor via opto-isolated power relay
--   * Modules self-describe their channel composition via HELLO (RS-485
--     CMD_HELLO on the device; relayed to the cloud over WSS as {type:"hello"}).
--
-- device_channels is the AUTHORITATIVE I/O map for a device. It is populated by
-- device-relay from the HELLO self-description, so the cloud/UI never hard-codes
-- a channel count — GEN-1 (no HELLO) falls back to the legacy view, GEN-2
-- renders exactly what the hardware reports.
--
-- Idempotent & safe to replay (rule #7).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- channel kind enum
-- ---------------------------------------------------------------------------
do $$
begin
  create type public.channel_kind as enum ('solenoid', 'motor_line');
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- devices.hw_model — reported via HELLO ('gen1' | 'gen2' | ...)
-- ---------------------------------------------------------------------------
alter table public.devices
  add column if not exists hw_model text;

comment on column public.devices.hw_model is
  'Hardware generation reported by the device HELLO self-description (e.g. gen1, gen2). Null for legacy devices that never sent HELLO.';

-- ---------------------------------------------------------------------------
-- DEVICE_CHANNELS — self-described I/O map per device
-- ---------------------------------------------------------------------------
create table if not exists public.device_channels (
  device_id     uuid not null references public.devices(id) on delete cascade,
  kind          public.channel_kind not null,
  channel_index smallint not null,            -- 1-based, unique within kind
  label         text,                         -- optional friendly name from HELLO
  module_id     text,                         -- HELLO module that owns this channel
  motor_type    text,                         -- 'dc' | 'ac' for motor_line; null for solenoid
  latching      boolean not null default true,-- solenoids are latching in GEN-2
  meta          jsonb not null default '{}',  -- forward-compatible extras
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (device_id, kind, channel_index)
);

comment on table public.device_channels is
  'Authoritative per-device I/O map from the HELLO self-description. Written only by device-relay (service role); readable by device owners/members.';

create index if not exists device_channels_device_idx
  on public.device_channels(device_id);

alter table public.device_channels enable row level security;

-- refresh updated_at on change (helper defined in initial_schema)
drop trigger if exists set_updated_at_device_channels on public.device_channels;
create trigger set_updated_at_device_channels
  before update on public.device_channels
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — owners/members SELECT only; all writes via service role / RPC below
-- (default deny covers INSERT/UPDATE/DELETE for anon/authenticated)
-- ---------------------------------------------------------------------------
drop policy if exists "device_channels: member can select" on public.device_channels;
create policy "device_channels: member can select"
  on public.device_channels for select
  using (public.user_owns_device(device_id));

-- ---------------------------------------------------------------------------
-- sync_device_channels(device_id, channels jsonb) — atomic HELLO reconciliation
--
-- Upserts every reported channel and prunes any channel no longer reported, in
-- one transaction. Called by device-relay (service role) on HELLO. Idempotent:
-- replaying the same HELLO is a no-op.
--
-- channels := [
--   { "kind":"solenoid",   "channel_index":1, "label":"Zone 1" },
--   ...
--   { "kind":"motor_line", "channel_index":1, "motor_type":"dc", "label":"Pump" },
--   { "kind":"motor_line", "channel_index":2, "motor_type":"ac" }
-- ]
-- ---------------------------------------------------------------------------
create or replace function public.sync_device_channels(
  p_device_id uuid,
  p_channels  jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_channels is null or jsonb_typeof(p_channels) <> 'array' then
    raise exception 'channels must be a json array' using errcode = 'P0005';
  end if;

  -- Upsert every reported channel.
  insert into public.device_channels
    (device_id, kind, channel_index, label, module_id, motor_type, latching, meta)
  select
    p_device_id,
    (c->>'kind')::public.channel_kind,
    (c->>'channel_index')::smallint,
    c->>'label',
    c->>'module_id',
    c->>'motor_type',
    coalesce((c->>'latching')::boolean, (c->>'kind') = 'solenoid'),
    coalesce(c->'meta', '{}'::jsonb)
  from jsonb_array_elements(p_channels) as c
  on conflict (device_id, kind, channel_index) do update
    set label      = excluded.label,
        module_id  = excluded.module_id,
        motor_type = excluded.motor_type,
        latching   = excluded.latching,
        meta       = excluded.meta,
        updated_at = now();

  -- Prune channels the device no longer advertises.
  delete from public.device_channels d
  where d.device_id = p_device_id
    and not exists (
      select 1
      from jsonb_array_elements(p_channels) as c
      where (c->>'kind')::public.channel_kind = d.kind
        and (c->>'channel_index')::smallint   = d.channel_index
    );
end;
$$;

comment on function public.sync_device_channels(uuid, jsonb) is
  'Reconcile a device''s channel map from its HELLO self-description (upsert reported + prune stale) in one transaction. Service-role only.';
