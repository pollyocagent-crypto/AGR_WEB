-- =============================================================================
-- Migration: rls_policies
-- AGR-119: Row-Level Security — default deny, then grant per spec
-- =============================================================================

-- Helper: returns true when the calling user has a row in device_owners
create or replace function public.user_owns_device(p_device_id uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.device_owners
    where device_id = p_device_id and user_id = auth.uid()
  );
$$;

-- =============================================================================
-- DEVICES — owner/member SELECT only; service_role full access
-- =============================================================================
create policy "devices: member can select"
  on public.devices for select
  using (public.user_owns_device(id));

-- =============================================================================
-- DEVICE_OWNERS — user sees own rows; INSERT only via pair_device() RPC
-- =============================================================================
create policy "device_owners: user sees own rows"
  on public.device_owners for select
  using (user_id = auth.uid());

-- No INSERT policy for anon/authenticated roles — pair_device() is security definer

-- =============================================================================
-- DEVICE_STATE — owner/member SELECT; INSERT/UPDATE service_role only
-- =============================================================================
create policy "device_state: member can select"
  on public.device_state for select
  using (public.user_owns_device(device_id));

-- =============================================================================
-- DEVICE_COMMANDS — owner/member SELECT + INSERT; UPDATE service_role only
-- =============================================================================
create policy "device_commands: member can select"
  on public.device_commands for select
  using (public.user_owns_device(device_id));

create policy "device_commands: member can insert"
  on public.device_commands for insert
  with check (
    requested_by = auth.uid()
    and public.user_owns_device(device_id)
  );

-- =============================================================================
-- PAIRING_CODES — no SELECT for users; SELECT via pair_device() security definer
-- =============================================================================
-- All user access goes through pair_device() security definer RPC.
-- service_role (device-bootstrap Edge Function) has full access implicitly
-- (service role bypasses RLS in Supabase).

-- =============================================================================
-- FIRMWARE_RELEASES — authenticated SELECT; INSERT/UPDATE service_role only
-- =============================================================================
create policy "firmware_releases: authenticated read"
  on public.firmware_releases for select
  to authenticated
  using (true);
