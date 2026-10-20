// Migration: audit_events_account_tool_action_time  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE/DROP INDEX CONCURRENTLY (and a
// handful of other operations: REINDEX CONCURRENTLY, DETACH PARTITION
// CONCURRENTLY) cannot run inside a transaction -- and every plain .sql
// migration in this repo runs inside the single batch transaction
// node-pg-migrate wraps around `pnpm migrate` (singleTransaction: true,
// see packages/db/scripts/migrate.ts). `pgm.noTransaction()` is
// node-pg-migrate's own supported opt-out: when it hits a migration that
// called this, it COMMITs the outer transaction, runs THIS migration
// standalone (no transaction), then re-opens BEGIN for whatever runs after
// it in the same batch. See MIGRATIONS.md "Roll-forward safety".
//
// Rules for this file:
//   - One LOGICAL operation -- the audit list's tool-action index. It takes
//     several statements because PostgreSQL cannot build an index CONCURRENTLY
//     on a partitioned PARENT ("cannot create index on partitioned table
//     ... concurrently", still true on PG 17 even with ON ONLY), and the
//     documented attach flow below is the only way to add one to a live
//     partitioned table without blocking writes. Each statement is
//     independently re-runnable.
//   - lock_timeout MUST be generous here -- 180s below, never the 2-5s used by
//     a plain .sql migration. CREATE INDEX CONCURRENTLY does not just take a
//     brief lock at the end: before it can start, and again before it can
//     finish, it waits for EVERY transaction in the database that began before
//     it (it takes a ShareLock on each one's virtual transaction id), and
//     `lock_timeout` governs that wait. On a live system -- audit_events
//     writers on every request, multi-second session-turn transactions -- some
//     transaction outlives a 5-second budget almost every time, so the build is
//     cancelled with 55P03 and leaves an INVALID index behind, which then makes
//     a plain re-run fail with "already exists". The 2-5s house value exists to
//     stop DDL blocking prod; the locks a CONCURRENTLY build holds
//     (ShareUpdateExclusive) only exclude other DDL and VACUUM,
//     so a long wait here blocks no user and that rationale does not apply.
//     This is lint-enforced: a new .concurrent.ts file that sets lock_timeout
//     below 120s fails `pnpm --filter @kortix/db lint`.
//   - statement_timeout should be generous (index builds on large tables can
//     legitimately run long) -- 30min below.
//   - This is lint-enforced: packages/db/scripts/lint-migrations.ts requires
//     pgm.noTransaction() AND a CONCURRENTLY operation in every .concurrent.ts
//     file, or CI fails.
//
// THE PROBLEM: the audit list endpoint's connector/computer filter (prod,
// Better Stack 2346961, 2026-10-17 21:10) crossed the 25 s statement timeout
// on a busy account:
//
//   GET /v1/accounts/:accountId/audit?action=connector.
//     (apps/api/src/accounts/audit.ts + audit-filters.ts; the `connector.`
//     prefix expands to the two tool-action prefixes the ledger records):
//
//   select * from kortix.audit_events_all
//    where account_id = $1
//      and (action like 'connector.%' or action like 'computer.%')
//    order by occurred_at desc, event_id desc
//    limit 50
//
// The walk index idx_audit_events_account_time (account_id, occurred_at)
// orders the rows but filters nothing, so Postgres walks the account's WHOLE
// recent ledger -- every request writes several non-tool rows (auth, session,
// gateway actions) between tool calls -- and heap-fetches each visited row
// (audit payload jsonb is wide) until it has found 50 tool rows. The
// standalone idx_audit_events_action_pattern (action text_pattern_ops) cannot
// help: its leading column is not the account, so it cannot serve an
// account-scoped scan (the same reason
// idx_audit_events_account_client_source_time was dropped 2026-09-29 -- an OR
// the planner cannot push through a composite index only reaches the
// account_time walk + Filter).
//
// This partial index carries exactly the two tool-action prefixes, so each
// index entry IS a row the query wants: the plan walks one account's tool
// rows newest-first, in the query's own order, and stops at LIMIT after ~50
// heap fetches. The predicate is the same two LIKE literals the filter
// builds (audit-filters.ts), so the planner proves the query's OR against
// the partial predicate and uses the index. Write cost is bounded: only
// tool-action rows are indexed, not the whole ledger.
//
// THE FLOW (PostgreSQL's documented one for a live partitioned table --
// audit_events is RANGE-partitioned by week, 20261001225732973):
//
//   1. CREATE INDEX ... ON ONLY kortix.audit_events -- the parent index as a
//      catalog-only entry, INVALID, instant (ON ONLY never scans data; its
//      ShareUpdateExclusive lock excludes other DDL and VACUUM, never reads
//      or writes). CONCURRENTLY is refused even here: PostgreSQL rejects a
//      concurrent build on any partitioned parent, so the non-concurrent
//      catalog-only form is the safe one. Executed DIRECTLY (pgm.db.query)
//      while up() runs -- BEFORE the partition enumeration below -- so any
//      partition ATTACHed from this moment on (the audit-partition worker's
//      weekly ensure_partitions, or CREATE TABLE ... PARTITION OF)
//      auto-creates its child of this index with no further work.
//   2. Per EXISTING partition that lacks one: CREATE INDEX CONCURRENTLY on the
//      partition (partitions are plain tables -- CONCURRENTLY works), then
//      ALTER INDEX <parent> ATTACH PARTITION <child>. When the last child
//      attaches, the parent index turns valid by itself.
//   3. Future partitions need nothing from this file (see 1: auto-inherit).
//      A partition ATTACHed between the enumeration and the queued statements
//      also auto-inherits, so this file has no enumeration window to guard.
//
// A PARTIALLY-FAILED run is safe to re-run: each child uses IF NOT EXISTS, an
// INVALID leftover child (a CONCURRENT build cancelled mid-build) is dropped
// and rebuilt before attaching, and a partition that already has a valid
// attached child (auto-created by a post-step-1 ATTACH, or attached by a
// previous run) is detected by DEFINITION -- not by name -- and skipped, so
// no duplicate child is ever built. The gateway-logs sibling migration
// (20261020070000000) is one statement because gateway_request_logs is not
// partitioned; this file is its partitioned-table counterpart.

export const shorthands = undefined;

const INDEX = 'idx_audit_events_account_tool_action_time';
const DEFINITION = `(account_id, occurred_at, event_id) where action like 'connector.%' or action like 'computer.%'`;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // Run DIRECTLY (pgm.db.query executes immediately; queued pgm.sql calls run
  // only after up() returns). The parent index must exist BEFORE the
  // enumeration query below, or a partition attached inside the
  // enumeration-to-execution window would inherit nothing and the parent
  // would stay invalid forever (the planner silently ignores it). The
  // timeouts are also set directly, for the same reason: the parent create
  // runs before any queued statement would have set them.
  await pgm.db.query(`set lock_timeout = '180s'`);
  await pgm.db.query(`set statement_timeout = '30min'`);
  await pgm.db.query(`
    create index if not exists ${INDEX}
      on only kortix.audit_events ${DEFINITION}
  `);

  // Enumerate the CURRENT partitions. Every partition attached after the
  // parent index was created (directly above) already has its (valid) child —
  // the loop skips those by definition, not by name.
  const { rows } = await pgm.db.query(
    `select c.relname as partition
       from pg_inherits i
       join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'kortix.audit_events'::regclass
      order by c.relname`,
  );

  for (const { partition } of rows) {
    // Schema-qualified identity everywhere: a same-named index in another
    // schema must never satisfy a check.
    const [attached] = await pgm.db.query(
      `select count(*)::int as children
         from pg_inherits ci
         join pg_class parent_i on parent_i.oid = ci.inhparent
         join pg_namespace pn on pn.oid = parent_i.relnamespace
         join pg_index i on i.indexrelid = ci.inhrelid
        where pn.nspname = 'kortix'
          and parent_i.relname = $1
          and i.indrelid = ('kortix.' || $2)::regclass
          and i.indisvalid`,
      [INDEX, partition],
    ).then((r) => r.rows);
    if (attached && attached.children > 0) continue;

    const child = `idx_ae_tool_time_${String(partition).replace(/^audit_events_/, '')}`;
    if (child.length > 63) throw new Error(`child index name too long: ${child}`);

    // A child left INVALID by a cancelled CONCURRENT build must be rebuilt:
    // attaching an invalid index would leave the parent permanently invalid.
    // (A plain partition's index is relkind 'i'; 'I' would be a partitioned
    // index, which can only appear on a partitioned table.)
    const [existing] = await pgm.db.query(
      `select i.indisvalid
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_index i on i.indexrelid = c.oid
        where c.relname = $1 and c.relkind = 'i' and n.nspname = 'kortix'`,
      [child],
    ).then((r) => r.rows);
    if (existing && !existing.indisvalid) {
      // mixed-version-safe: the only index this can drop is THIS migration's
      // own child (name-prefixed idx_ae_tool_time_), left INVALID by a
      // cancelled CONCURRENT build of a previous partial run. It was created
      // by this same migration, is not yet attached to the parent, and no old
      // code can read it (the planner ignores an index that is not attached).
      pgm.sql(`drop index if exists kortix.${child}`);
    }
    pgm.sql(`create index concurrently if not exists ${child} on kortix."${partition}" ${DEFINITION}`);

    // ATTACH the freshly built child. Partitions that already had a child
    // were skipped above (ALTER INDEX ... ATTACH PARTITION errors on an
    // already-attached child).
    pgm.sql(`alter index kortix.${INDEX} attach partition kortix.${child}`);
  }
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
