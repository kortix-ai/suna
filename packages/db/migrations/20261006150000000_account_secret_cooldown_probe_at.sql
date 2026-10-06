-- Migration: account_secret_cooldown_probe_at
--
-- A ChatGPT connection that hits its plan's usage limit rests until the reset
-- the provider names (up to 8 days, kortix.account_secret_resources.cooldown_until).
-- A user who resets their usage early stayed on paid fallback models for days,
-- because nothing re-tried the connection (2026-10-06).
--
-- cooldown_probe_at is when a resting connection may be re-tried. Each recorded
-- limit sets it 15 minutes out; the first gateway resolve after it lifts the
-- rest once, so real traffic re-tries the connection, and a second limit rests
-- it again. Nullable, no default: an add-column that only touches the catalog.
set lock_timeout = '2s';
set statement_timeout = '30s';

alter table kortix.account_secret_resources
  add column if not exists cooldown_probe_at timestamptz;
