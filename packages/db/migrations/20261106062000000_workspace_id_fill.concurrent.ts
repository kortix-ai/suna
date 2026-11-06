// Migration: workspace_id_fill  (NON-TRANSACTIONAL -- batched data pass)
//
// Workspaces M8 (design: .agents/skills/learnings/work/workspaces/design.md §3.3, §6.2).
// Fills workspace_id on the existing rows of the 44 expand tables
// (kortix.workspace_expand_tables(), the columns M7 added). New rows already
// get it from the M7 BEFORE triggers.
//
// batched-dml: per table, smallest first, 5,000 rows per statement, each
// statement its own transaction (pgm.noTransaction), pg_sleep(0.02) between
// statements. A table with a one-column primary key is walked by keyset on
// that key; a table with a composite key (or a partitioned table, leaf by
// leaf) by ctid block ranges sized to ~5,000 rows. Each statement sets
// workspace_id from kortix.workspaces: the account's one live row that is not
// split_pending. Rows of a split_pending account, and rows whose account has
// no live row, stay NULL (the split fills its accounts after the last move,
// kortix.workspace_fill_account). Row locks only, on the rows of one batch.
//
// Measured on the 1/20 prod-shape seed (apps/api/scripts/seed-prod-shape.ts):
// see the PR. credit_ledger (8.6M rows on prod) dominates. Each batch writes
// new row versions: expect credit_ledger to grow by up to one table size of
// dead tuples until autovacuum reclaims them, and the WAL of one table copy.
//
// Idempotent: only rows with workspace_id IS NULL are written, so a rerun
// after a failure finishes the rest.
//
// Mixed-version deploy: the old image never reads workspace_id on these tables.
//
// ROLL BACK: no down migration (repo policy). Nothing reads the column in
// Release 1; UPDATE ... SET workspace_id = NULL in batches empties it.

export const shorthands = undefined;

const BATCH_ROWS = 5000;
const SLEEP_SECONDS = 0.02;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** The live, non-split workspace id of the row's account, as a join. */
const fillFrom = (table, where) => `
  update kortix.${table} t
     set workspace_id = w.workspace_id
    from kortix.workspaces w
   where w.legacy_account_id = t.account_id
     and w.lifecycle <> 'tombstone'
     and not w.split_pending
     and t.workspace_id is null
     and ${where}`;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
async function q(pgm, text) {
  return pgm.db.query(text);
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
async function fillByKey(pgm, table, key) {
  let after = null;
  for (;;) {
    const bound = after === null ? 'true' : `t2.${key} > ${after}`;
    const { rows } = await q(
      pgm,
      `select (array_agg(k::text order by k desc))[1] as last, count(*)::int as n from (
         select t2.${key} as k from kortix.${table} t2
          where ${bound} order by t2.${key} limit ${BATCH_ROWS}) s`,
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n === 0) return;
    const last = String(rows[0].last).replace(/'/g, "''");
    const lower = after === null ? 'true' : `t.${key} > ${after}`;
    await q(pgm, fillFrom(table, `${lower} and t.${key} <= '${last}'`));
    await q(pgm, `select pg_sleep(${SLEEP_SECONDS})`);
    after = `'${last}'`;
    if (n < BATCH_ROWS) return;
  }
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
async function fillByCtid(pgm, leaf) {
  const { rows } = await q(
    pgm,
    `select greatest(c.relpages, 1)::bigint as pages, greatest(c.reltuples, 0)::bigint as tuples,
            (pg_relation_size(c.oid) / current_setting('block_size')::bigint)::bigint as blocks
       from pg_class c where c.oid = 'kortix.${leaf}'::regclass`,
  );
  const blocks = Number(rows[0]?.blocks ?? 0);
  if (blocks === 0) return;
  const perBlock = Math.max(1, Number(rows[0].tuples) / Number(rows[0].pages));
  const step = Math.max(1, Math.floor(BATCH_ROWS / perBlock));
  for (let start = 0; start < blocks; start += step) {
    const end = start + step;
    await q(
      pgm,
      fillFrom(leaf, `t.ctid >= '(${start},0)'::tid and t.ctid < '(${end},0)'::tid`),
    );
    await q(pgm, `select pg_sleep(${SLEEP_SECONDS})`);
  }
  // Rows written after the size was read sit past the last range.
  await q(pgm, fillFrom(leaf, `t.ctid >= '(${blocks},0)'::tid`));
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  await q(pgm, `set lock_timeout = '5s'`);
  await q(pgm, `set statement_timeout = '5min'`);

  const { rows: tables } = await q(
    pgm,
    `select t.name, c.relkind::text as kind,
            (select array_agg(a.attname::text order by k.ord)
               from pg_index i
               cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
              where i.indrelid = c.oid and i.indisprimary) as pk,
            pg_total_relation_size(c.oid) as bytes
       from unnest(kortix.workspace_expand_tables()) as t(name)
       join pg_class c on c.oid = to_regclass('kortix.' || quote_ident(t.name))
      where exists (select 1 from pg_attribute a
                     where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped)
      order by pg_total_relation_size(c.oid), t.name`,
  );

  for (const table of tables) {
    const name = String(table.name);
    if (!IDENT_RE.test(name)) throw new Error(`workspace_id_fill: bad table name ${name}`);
    const pk = Array.isArray(table.pk) ? table.pk.map(String) : [];
    if (table.kind === 'p') {
      const { rows: leaves } = await q(
        pgm,
        `select c.relname::text as name from pg_partition_tree('kortix.${name}'::regclass) pt
           join pg_class c on c.oid = pt.relid where pt.isleaf order by c.relname`,
      );
      for (const leaf of leaves) {
        const leafName = String(leaf.name);
        if (!IDENT_RE.test(leafName)) throw new Error(`workspace_id_fill: bad partition name ${leafName}`);
        await fillByCtid(pgm, leafName);
      }
    } else if (pk.length === 1 && IDENT_RE.test(pk[0])) {
      await fillByKey(pgm, name, pk[0]);
    } else {
      await fillByCtid(pgm, name);
    }
  }
};

export const down = false;
