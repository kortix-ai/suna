-- Add missing credit_ledger columns used by current billing code.
-- Safe to run repeatedly.

alter table if exists kortix.credit_ledger
  add column if not exists idempotency_key text;

alter table if exists kortix.credit_ledger
  add column if not exists processing_source text;

create index if not exists idx_kortix_credit_ledger_idempotency
  on kortix.credit_ledger(idempotency_key)
  where idempotency_key is not null;
