-- Billing v2 — per-second compute metering.
-- One row per sandbox lifetime "active" window. Hibernate/restart closes the row
-- and opens a new one on resume. Finalized cost flows into kortix.credit_ledger
-- as a `compute_debit` entry; this table is the audit trail.

CREATE TABLE IF NOT EXISTS kortix.sandbox_compute_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  sandbox_id      uuid NOT NULL,
  session_id      text,
  actor_user_id   uuid,

  -- Reserved spec at session start (from kortix.toml [sandbox]). We bill against
  -- these declared values, not actual utilization.
  cpu_cores       integer NOT NULL,
  memory_gb       integer NOT NULL,
  disk_gb         integer NOT NULL,
  gpu_count       integer NOT NULL DEFAULT 0,

  -- 'active' = currently running and accruing charges.
  -- 'stopped' = sandbox is paused but still present (storage rate applies if implemented later).
  -- 'finalized' = closed; cost_usd is the final number and a ledger entry exists.
  state           text NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active', 'stopped', 'finalized')),

  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  last_billed_at  timestamptz NOT NULL DEFAULT now(),

  -- Running total in USD. Updated by partial bills (cron tick) and on close.
  cost_usd        numeric(12, 6) NOT NULL DEFAULT 0,

  -- Ledger linkage so we can prove the debit was emitted exactly once.
  ledger_id       uuid REFERENCES kortix.credit_ledger(id) ON DELETE SET NULL,

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Lookup all sessions for an account over time (billing reports, usage UI).
CREATE INDEX IF NOT EXISTS idx_sandbox_compute_sessions_account_time
  ON kortix.sandbox_compute_sessions (account_id, started_at DESC);

-- Find the open row for a sandbox quickly when lifecycle hooks fire.
CREATE INDEX IF NOT EXISTS idx_sandbox_compute_sessions_open
  ON kortix.sandbox_compute_sessions (sandbox_id)
  WHERE ended_at IS NULL;

-- Cron tick: find long-running sessions due for partial billing.
CREATE INDEX IF NOT EXISTS idx_sandbox_compute_sessions_last_billed
  ON kortix.sandbox_compute_sessions (last_billed_at)
  WHERE state = 'active';
