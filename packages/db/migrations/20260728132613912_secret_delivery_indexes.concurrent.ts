// Migration: secret_delivery_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE INDEX CONCURRENTLY cannot run inside a
// transaction, and every plain .sql migration here runs inside the single batch
// transaction node-pg-migrate wraps around `pnpm migrate`. `pgm.noTransaction()`
// is the supported opt-out. See MIGRATIONS.md "Roll-forward safety".
//
// The indexes Stage 1 of the Secret Delivery Strategy needs, split out from
// 20260728132613911_secret_delivery_strategy.sql. Three of them are on the table
// that migration creates -- empty, so they build instantly -- but they live here
// anyway rather than as a plain CREATE INDEX, because the house rule is that
// index creation goes through CONCURRENTLY without exception. The fourth is on
// project_secrets, which is populated, where it genuinely matters.
//
// None of these four is declared in packages/db/src/schema/kortix.ts, following
// the pattern documented at 20260727113441903_project_sessions_account_active_index
// .concurrent.ts: a declared index makes `db:generate` emit a conflicting plain
// CREATE INDEX against the one already built here. Both tables carry a NOTE
// comment pointing at this file so the indexes stay discoverable from the schema.
//
// What each one is for:
//
//   _lookup        the broker's hot path. A presented handle carries a 96-bit
//                  lookup_id; this is the single-row fetch that turns it into a
//                  session, a secret and a frozen policy. UNIQUE because two
//                  rows sharing a lookup_id would make that resolution ambiguous
//                  -- i.e. would decide which credential to spend by chance.
//   _session       fan-out by session: mint-or-reuse at boot reads every handle
//                  the session holds, and session teardown revokes them.
//   _session_secret_rev  the mint-or-reuse uniqueness itself. Boot and the
//                  per-prompt hot push both call the same resolver, so without
//                  this a concurrent boot + push can mint two live handles for
//                  one (session, secret) and the box ends up holding whichever
//                  landed last -- the parity regression class that has already
//                  cost this codebase twice.
//   _project_strategy    "does this project have any non-runtime secret?", which
//                  the resolver asks per session create. PARTIAL on
//                  strategy <> 'runtime' so it indexes nothing at all until a
//                  project opts in -- on the day this ships, every row defaults
//                  to 'runtime' and the index is empty.
//
// IF NOT EXISTS makes each statement a no-op where the index already exists, so
// this is safe to re-run. Purely additive: new indexes, no code depends on their
// absence, and CREATE INDEX CONCURRENTLY never blocks writes.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls -- a multi-statement simple query is an
  // implicit transaction block, which silently defeats noTransaction().
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create unique index concurrently if not exists idx_secret_handles_lookup
      on kortix.project_session_secret_handles (lookup_id)
  `);
  pgm.sql(`
    create index concurrently if not exists idx_secret_handles_session
      on kortix.project_session_secret_handles (session_id)
  `);
  pgm.sql(`
    create unique index concurrently if not exists idx_secret_handles_session_secret_rev
      on kortix.project_session_secret_handles (session_id, secret_id, revision)
  `);
  // The index above is uniqueness per REVISION, which is not the invariant the
  // resolver actually depends on: (sess, secret, rev 1, active) and
  // (sess, secret, rev 2, active) both satisfy it, so two LIVE handles for one
  // (session, secret) remain representable. That is vacuously safe only while
  // revision is always 1; the moment rotation lands it is false, and the box
  // would hold whichever handle it happened to receive last while both resolve.
  // Partial-unique on the live rows is the invariant itself.
  // Validate the NOT VALID check added alongside. Takes SHARE UPDATE EXCLUSIVE
  // (concurrent reads and writes continue) and, since every existing row is
  // 'runtime', finds nothing to reject.
  pgm.sql(`
    alter table kortix.project_secrets
      validate constraint project_secrets_egress_policy_required
  `);
  pgm.sql(`
    create unique index concurrently if not exists idx_secret_handles_one_active
      on kortix.project_session_secret_handles (session_id, secret_id)
      where status = 'active'
  `);
  pgm.sql(`
    create index concurrently if not exists idx_project_secrets_project_strategy
      on kortix.project_secrets (project_id, strategy)
      where strategy <> 'runtime'
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md).
export const down = false;
