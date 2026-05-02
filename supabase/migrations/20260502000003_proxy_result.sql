-- =============================================================================
-- Migration: proxy_result
-- AGR-139: Add result column to device_commands for HTTP proxy responses
-- =============================================================================

alter table public.device_commands
  add column if not exists result jsonb;

comment on column public.device_commands.result is
  'Response payload from device (populated on ack). Used by HTTP proxy to return device responses.';
