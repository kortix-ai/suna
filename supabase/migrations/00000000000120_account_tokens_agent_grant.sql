-- Agent-scoped PATs store the resolved per-agent grant on the token.
-- The application schema already selects this column during PAT validation;
-- keep the migration idempotent so environments that were manually repaired
-- stay clean.
alter table kortix.account_tokens
  add column if not exists agent_grant jsonb;
