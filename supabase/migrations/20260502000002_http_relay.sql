-- =============================================================================
-- Migration: http_relay
-- AGR-140: Add result column to device_commands for HTTP proxy responses
-- =============================================================================

-- Store HTTP response from device (status, content_type, body_b64).
-- Only populated for commands with payload.type = 'http'.
alter table public.device_commands
  add column if not exists result jsonb;

-- Speed up the polling query in the Vercel proxy route:
-- SELECT ... WHERE id = $1 AND status != 'pending'
create index if not exists device_commands_id_status_idx
  on public.device_commands(id, status);
