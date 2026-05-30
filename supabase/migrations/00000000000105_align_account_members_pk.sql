-- ============================================================================
-- 00000000000105  align_account_members_pk
-- Restore the composite PRIMARY KEY on kortix.account_members (user_id,
-- account_id) that `drizzle-kit push` silently drops.
--
-- Why it goes missing: in dev/staging the schema runner runs `drizzle-kit push`
-- FIRST, which creates account_members from packages/db/src/schema/kortix.ts.
-- That table's key is declared as a `uniqueIndex(... userId, accountId)` in the
-- Drizzle schema (NOT a table-level primaryKey()), and push does not always
-- materialize it as a real constraint — leaving the table with NO unique/PK
-- constraint at all. Every code path that does
--     INSERT ... ON CONFLICT (user_id, account_id) ...
-- (invite acceptance, member add, YOLO seat mgmt) then dies with
--     42P10: there is no unique or exclusion constraint matching the ON CONFLICT
-- → invite acceptance 500s. The bootstrap migration DOES create the unique
-- index on a clean `supabase db reset`, so this file is a guarded no-op there.
--
-- Idempotent: dedups any pre-existing duplicate (user_id, account_id) rows
-- (keeping the earliest by ctid), then adds the PK + the named unique index
-- only if absent. Safe to re-run on every boot.
-- ============================================================================

-- 1. Dedup any rows that accumulated while no unique constraint existed.
--    Keep one row per (user_id, account_id) — the physically-first (ctid).
DELETE FROM kortix.account_members a
USING kortix.account_members b
WHERE a.user_id = b.user_id
  AND a.account_id = b.account_id
  AND a.ctid > b.ctid;

-- 2. Add the composite primary key if the table has no primary key yet.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'kortix.account_members'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE kortix.account_members
      ADD CONSTRAINT account_members_pkey PRIMARY KEY (user_id, account_id);
  END IF;
END $$;

-- 3. Ensure the named unique index the bootstrap migration declares also exists
--    (schema parity; the PK already satisfies the ON CONFLICT target).
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_members_user_account
  ON kortix.account_members (user_id, account_id);
