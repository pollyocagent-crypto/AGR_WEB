-- =============================================================================
-- Migration: functions
-- AGR-119: Server-side SQL functions (security definer)
-- =============================================================================

-- =============================================================================
-- pair_device(p_code) → device_id
--
-- Called by authenticated web app user after scanning the HMI QR code.
-- Validates the pairing code, creates device_owners row, deletes the code.
-- Security definer: runs as postgres superuser, bypasses RLS.
-- =============================================================================
create or replace function public.pair_device(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id uuid;
  v_expires_at timestamptz;
begin
  -- Must be called by an authenticated user
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Look up the code
  select device_id, expires_at
    into v_device_id, v_expires_at
    from public.pairing_codes
   where code = p_code;

  if not found then
    raise exception 'invalid_code' using errcode = 'P0002';
  end if;

  if v_expires_at < now() then
    -- Clean up expired code
    delete from public.pairing_codes where code = p_code;
    raise exception 'code_expired' using errcode = 'P0003';
  end if;

  -- Consume the code immediately (prevents concurrent claims)
  delete from public.pairing_codes where code = p_code;

  -- Create ownership row (idempotent via ON CONFLICT DO NOTHING)
  insert into public.device_owners (device_id, user_id, role)
    values (v_device_id, auth.uid(), 'owner')
    on conflict (device_id, user_id) do nothing;

  return v_device_id;
end;
$$;

comment on function public.pair_device(text) is
  'Claim a device using a 6-digit pairing code. Creates device_owners row for the calling user.';


-- =============================================================================
-- request_command(p_device_id, p_payload) → command_id
--
-- Validates ownership, then inserts a pending command into device_commands.
-- The device-relay Edge Function polls for pending commands and forwards them.
-- =============================================================================
create or replace function public.request_command(
  p_device_id uuid,
  p_payload   jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_command_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Verify the caller owns or is a member of the device
  if not public.user_owns_device(p_device_id) then
    raise exception 'forbidden' using errcode = 'P0004';
  end if;

  insert into public.device_commands (device_id, payload, requested_by)
    values (p_device_id, p_payload, auth.uid())
    returning id into v_command_id;

  return v_command_id;
end;
$$;

comment on function public.request_command(uuid, jsonb) is
  'Insert a command for a device the caller owns. Returns the new command id.';
