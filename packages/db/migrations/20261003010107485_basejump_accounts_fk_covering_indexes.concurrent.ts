// Migration: basejump_accounts_fk_covering_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Covers both unindexed foreign keys on basejump.accounts — the exact set the
// Supabase performance advisor reports as `unindexed_foreign_keys` on that
// table (2026-10-02 prod: accounts_created_by_fkey on column 8,
// accounts_updated_by_fkey on column 9; both INFO, EXTERNAL facing). Each index
// takes the constraint's name, Postgres's convention for the index that serves
// an FK — the psql \d hint and every FK-covering-index tooling looks it up that
// way.
//
// basejump is retired for the app (20260706120000000_retire_basejump) but the
// schema itself is NOT dropped — see that migration's header — so the table and
// its FKs live on. No app query reads basejump.accounts; these indexes serve
// the FK's own referential-integrity check on UPDATE/DELETE of auth.users rows,
// which without a covering index seq-scans basejump.accounts per touched auth
// row.
//
// Two statements, one file: both indexes serve the same finding on the same
// table, and CREATE INDEX CONCURRENTLY holds only ShareUpdateExclusive — the
// two builds queue on it but block no reader or writer.
//
// Guarded on the table existing: the migration chain never creates
// basejump.accounts (the bootstrap installs only the basejump.account_user stub
// — packages/db/scripts/test-prereqs.sql and drizzle/0000_bootstrap.sql), so on
// a fresh self-host install or the CI shadow database the table is absent and
// both statements are skipped. That skip is the correct end state there: no
// table, no FK, nothing for the advisor to flag. The guard runs through
// pgm.db.query so the CONCURRENTLY statements below stay bare — a DO $$ IF … $$
// guard would wrap them in an implicit transaction block and fail.
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY waits
// for every transaction that began before it, and lock_timeout governs that wait.
// IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a failed build must
// be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  // Table-presence guard (see the header). pgm.db.query keeps the session
  // transaction-free; the row comes back as { ok: boolean }.
  const {
    rows: [table],
  } = await pgm.db.query("select to_regclass('basejump.accounts') is not null as ok");
  if (!table?.ok) {
    console.log(
      '[basejump_accounts_fk_covering_indexes] basejump.accounts absent — nothing to index',
    );
    return;
  }
  // Column-presence guard: older environments carry a narrower legacy
  // basejump.accounts whose shape predates the created_by / updated_by audit
  // columns (the advisor finding comes from prod's current shape). Index only
  // the columns the table actually has, so the same migration batch serves
  // both shapes; the FK itself lives only where its column does.
  const {
    rows: [cols],
  } = await pgm.db.query(
    `select
       bool_or(column_name = 'created_by') as created_by,
       bool_or(column_name = 'updated_by') as updated_by
     from information_schema.columns
     where table_schema = 'basejump' and table_name = 'accounts'
       and column_name in ('created_by', 'updated_by')`,
  );
  if (cols?.created_by) {
    pgm.sql(`
      create index concurrently if not exists accounts_created_by_fkey
        on basejump.accounts using btree (created_by)
    `);
  }
  if (cols?.updated_by) {
    pgm.sql(`
      create index concurrently if not exists accounts_updated_by_fkey
        on basejump.accounts using btree (updated_by)
    `);
  }
};

export const down = false;
