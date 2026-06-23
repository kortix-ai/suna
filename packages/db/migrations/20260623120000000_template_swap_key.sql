-- Up Migration
--
-- Agent-swap eligibility key for the kortix-agent CAS swap (kill the mass-rebuild).
-- Per template, stores the identity of everything the swap does NOT touch — the
-- user image + spec + NON-agent runtime layer (opencode/entrypoint/CLI/slack-cli/
-- executor-sdk/manifest-schema + layer/browser/sandbox version constants).
-- snapshots/builder.ts swaps the agent binary in place of a full rebuild ONLY when
-- a drifted template's NEW identity swapKey equals this stored value — i.e. the
-- agent binary is the sole delta. NULL for existing rows (and the platform default
-- until first build) → those take the normal full-rebuild path, so the rollout is
-- gradual and can never ship a stale image.

ALTER TABLE kortix.sandbox_templates ADD COLUMN IF NOT EXISTS swap_key text;

-- Down Migration
ALTER TABLE kortix.sandbox_templates DROP COLUMN IF EXISTS swap_key;
