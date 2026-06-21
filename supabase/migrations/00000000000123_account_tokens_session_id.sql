-- Sandbox executor tokens are minted per session (session_id = sandbox_id).
-- Recording it on the token lets the LLM gateway attribute usage_events to the
-- calling session — the sandbox reaper's reliable "real activity" signal and
-- precise per-session compute/LLM billing. Nullable: laptop CLI PATs and
-- project-scoped operator tokens have no session. Idempotent.
alter table kortix.account_tokens
  add column if not exists session_id text;
