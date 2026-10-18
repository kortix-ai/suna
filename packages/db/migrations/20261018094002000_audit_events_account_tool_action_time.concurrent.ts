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
//   - One LOGICAL operation -- the index. It takes several statements because
//     PostgreSQL cannot build an index CONCURRENTLY on a partitioned PARENT
//     ("cannot create index on partitioned table ... concurrently", still true
//     on PG 17), and the documented attach flow below is the only way to add
//     one to a live partitioned table without blocking writes. Each statement
//     is independently re-runnable.
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
//   - DROPPING an index/constraint here (not just creating one) is ALSO
//     covered by the mixed-version guard, same as a plain .sql migration --
//     add `// mixed-version-safe: <justification>` above `up` if this drops
//     something old code might still read (see MIGRATIONS.md).

export const shorthands = undefined;

const INDEX = 'idx_audit_events_account_tool_action_time';
const DEFINITION = `(account_id, occurred_at, event_id) where action like 'connector.%' or action like 'computer.%'`;

// The audit list endpoint's connector/computer filter (prod, Better Stack
// 2346961, 2026-10-17 21:10) crossed the 25 s statement timeout on a busy
// account:
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
// WHY THE ATTACH FLOW: audit_events is RANGE-partitioned by week
// (20261001225732973). A plain CREATE INDEX on the parent builds inside every
// existing partition while blocking that partition's writes; CONCURRENTLY is
// refused on the parent outright. PostgreSQL's documented flow for a live
// partitioned table:
//
//   1. CREATE INDEX ... ON ONLY kortix.audit_events -- instant (catalog only);
//      the parent index starts INVALID. CONCURRENTLY is refused even here:
//      PostgreSQL rejects a concurrent build on any partitioned parent.
//   2. Per existing partition: CREATE INDEX CONCURRENTLY on the partition
//      (partitions are plain tables -- CONCURRENTLY works), then
//      ALTER INDEX <parent> ATTACH PARTITION <child>. When the last child
//      attaches, the parent index turns valid by itself.
//   3. Future partitions need nothing: both partition-creation paths
//      (CREATE TABLE ... PARTITION OF and the ensure_partitions ATTACH) auto-
//      create the parent's partitioned indexes on the new partition.
//
// A PARTIALLY-FAILED run is safe to re-run: the parent and every child use
// IF NOT EXISTS, an INVALID leftover child (a CONCURRENT build cancelled
// mid-build) is dropped and rebuilt before attaching, and an already-attached
// child is detected and skipped. The gateway-logs sibling migration
// (20261018093447137) is one statement because gateway_request_logs is not
// partitioned; this file is its partitioned-table counterpart.
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  // The PARENT index must be a plain CREATE INDEX: PostgreSQL refuses
  // CONCURRENTLY on a partitioned parent outright -- even with ON ONLY
  // ("cannot create index on partitioned table ... concurrently"). ON ONLY
  // never scans data: it is a catalog-only entry, created invalid, and takes
  // ShareUpdateExclusive (excludes other DDL and VACUUM, not reads/writes),
  // so the non-concurrent form is safe here. The actual row work happens
  // per partition, CONCURRENTLY, below.
  pgm.sql(`
    create index if not exists ${INDEX}
      on only kortix.audit_events ${DEFINITION}
  `);

  // Enumerate the CURRENT partitions. Runs through pgm.db on the migration's
  // own connection, before the queued statements execute.
  const { rows } = await pgm.db.query(
    `select c.relname as partition
       from pg_inherits i
       join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'kortix.audit_events'::regclass
      order by c.relname`,
  );

  for (const { partition } of rows) {
    const child = `idx_ae_tool_time_${String(partition).replace(/^audit_events_/, '')}`;
    if (child.length > 63) throw new Error(`child index name too long: ${child}`);

    // A child left INVALID by a cancelled CONCURRENT build must be rebuilt:
    // attaching an invalid index would leave the parent permanently invalid.
    // (A plain partition's index is relkind 'i'; 'I' would be a partitioned
    // index, which can only appear on a partitioned table.)
    const [existing] = await pgm.db.query(
      `select i.indisvalid
         from pg_class c
         join pg_index i on i.indexrelid = c.oid
        where c.relname = $1 and c.relkind = 'i'`,
      [child],
    ).then((r) => r.rows);
    if (existing && !existing.indisvalid) {
      pgm.sql(`drop index if exists kortix.${child}`);
    }
    pgm.sql(`create index concurrently if not exists ${child} on kortix."${partition}" ${DEFINITION}`);

    // Skip the ATTACH when a previous run already attached this child
    // (ALTER INDEX ... ATTACH PARTITION errors on an already-attached child).
    const attached = await pgm.db.query(
      `select 1
         from pg_class parent_i
         join pg_inherits inh on inh.inhparent = parent_i.oid
         join pg_class child_i on child_i.oid = inh.inhrelid
        where parent_i.relname = $1 and child_i.relname = $2`,
      [INDEX, child],
    );
    if (attached.rowCount === 0) {
      pgm.sql(`alter index kortix.${INDEX} attach partition kortix.${child}`);
    }
  }
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
