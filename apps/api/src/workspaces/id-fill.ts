/**
 * The Release 1 `workspace_id` fill, as a throttled background job
 * (design.md §3.3 M8). It replaces the M8 migration: on prod the fill writes
 * ~8.6M `credit_ledger` row versions (~4.5 GB of dead tuples and the WAL of
 * one table copy). Inside the deploy's migrate-db job that held the rollout
 * for ~5.3 min; here it runs after the deploy, a batch at a time.
 *
 * What it does: sets `workspace_id` where it is NULL on the expand tables
 * (`kortix.workspace_expand_tables()`, the columns M7 added), from the
 * account's one live `kortix.workspaces` row that is not `split_pending`.
 * Rows of a `split_pending` account, and rows whose account has no live row,
 * stay NULL: the split fills an account after its last move
 * (`kortix.workspace_fill_account`). New rows never need it: the M7 BEFORE
 * triggers stamp them.
 *
 * How:
 *   - The plan: every expand table that has the column, smallest first (by
 *     `pg_total_relation_size`); a partitioned table leaf by leaf. Built once
 *     and stored with the progress, so the order never changes mid-run.
 *   - One tick = one batch of `batch_rows` rows (default 5,000), in its own
 *     transaction with `lock_timeout 5s` and `statement_timeout 60s`. Row
 *     locks only, on the rows of that batch. A table with a one-column primary
 *     key is walked by keyset on that key; any other by `ctid` block ranges
 *     sized to ~`batch_rows` rows.
 *   - The progress (cursor, rows written per table) commits in the same
 *     transaction as the batch: a crash, a deploy or a lease move resumes at
 *     the next batch, never repeats a committed one, never skips one.
 *   - Between batches the job waits `pause_ms` (default 250 ms). That bounds
 *     the write rate to about 5,000 rows per (batch time + 250 ms).
 *
 * Control: the `workspace_id_fill` platform setting, written by an operator:
 *   `{ "paused": true }`              stops after the batch in flight;
 *   `{ "batch_rows": n, "pause_ms": m }` retunes the throttle (1,000–20,000 rows,
 *                                      50 ms–60 s).
 * Progress: the `workspace_id_fill_progress` platform setting, written only by
 * the job. Deleting it starts the fill again from the first table (safe: only
 * NULL rows are written).
 */
import { platformSettings } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { logger } from '../lib/logger';
import { db } from '../shared/db';

export const WORKSPACE_ID_FILL_SETTING_KEY = 'workspace_id_fill';
export const WORKSPACE_ID_FILL_PROGRESS_KEY = 'workspace_id_fill_progress';

const DEFAULT_BATCH_ROWS = 5_000;
const DEFAULT_PAUSE_MS = 250;
/** Idle wait while paused or after the fill finished: re-read the setting hourly. */
export const WORKSPACE_ID_FILL_IDLE_MS = 60 * 60_000;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export interface WorkspaceIdFillControl {
  paused: boolean;
  batchRows: number;
  pauseMs: number;
}

/** One unit of the plan: a table, or one leaf of a partitioned table. */
export interface WorkspaceIdFillTarget {
  table: string;
  /** `key`: keyset on `key`; `ctid`: block ranges. */
  walk: 'key' | 'ctid';
  key: string | null;
  /** Last key written (`key`), or the next block to start at (`ctid`). */
  cursor: string | null;
  rows: number;
  done: boolean;
}

export interface WorkspaceIdFillProgress {
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  rows: number;
  batches: number;
  targets: WorkspaceIdFillTarget[];
}

export type WorkspaceIdFillTick =
  | { state: 'paused' | 'finished'; nextDelayMs: number }
  | { state: 'filled'; table: string; rows: number; nextDelayMs: number };

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

async function readSetting(key: string): Promise<unknown> {
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

/** The operator's control, defaults filled in. */
export async function workspaceIdFillControl(): Promise<WorkspaceIdFillControl> {
  const value = ((await readSetting(WORKSPACE_ID_FILL_SETTING_KEY)) ?? {}) as Record<string, unknown>;
  return {
    paused: value.paused === true,
    batchRows: clamp(value.batch_rows, 1_000, 20_000, DEFAULT_BATCH_ROWS),
    pauseMs: clamp(value.pause_ms, 50, 60_000, DEFAULT_PAUSE_MS),
  };
}

/** The stored progress, or null before the first batch (or after an operator reset). */
export async function workspaceIdFillProgress(): Promise<WorkspaceIdFillProgress | null> {
  const value = await readSetting(WORKSPACE_ID_FILL_PROGRESS_KEY);
  return value && typeof value === 'object' && Array.isArray((value as WorkspaceIdFillProgress).targets)
    ? (value as WorkspaceIdFillProgress)
    : null;
}

/** The plan: expand tables (leaves of partitioned ones) that carry the column, smallest first. */
async function buildPlan(): Promise<WorkspaceIdFillTarget[]> {
  const tables = await db.execute<{ name: string; kind: string; pk: string[] | null }>(sql`
    SELECT t.name, c.relkind::text AS kind,
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM pg_index i
              CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE i.indrelid = c.oid AND i.indisprimary) AS pk
      FROM unnest(kortix.workspace_expand_tables()) AS t(name)
      JOIN pg_class c ON c.oid = to_regclass('kortix.' || quote_ident(t.name))
     WHERE EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
     ORDER BY pg_total_relation_size(c.oid), t.name`);
  const targets: WorkspaceIdFillTarget[] = [];
  for (const row of tables) {
    const name = String(row.name);
    if (!IDENT_RE.test(name)) throw new Error(`workspace_id fill: bad table name ${name}`);
    if (row.kind === 'p') {
      const leaves = await db.execute<{ name: string }>(sql`
        SELECT c.relname::text AS name FROM pg_partition_tree(${`kortix.${name}`}::regclass) pt
          JOIN pg_class c ON c.oid = pt.relid
         WHERE pt.isleaf ORDER BY c.relname`);
      for (const leaf of leaves) {
        const leafName = String(leaf.name);
        if (!IDENT_RE.test(leafName)) throw new Error(`workspace_id fill: bad partition name ${leafName}`);
        targets.push({ table: leafName, walk: 'ctid', key: null, cursor: null, rows: 0, done: false });
      }
      continue;
    }
    const pk = Array.isArray(row.pk) ? row.pk.map(String) : [];
    const key = pk.length === 1 && IDENT_RE.test(pk[0]!) ? pk[0]! : null;
    targets.push({ table: name, walk: key ? 'key' : 'ctid', key, cursor: null, rows: 0, done: false });
  }
  return targets;
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** `UPDATE … SET workspace_id` for the rows of one target that `where` selects. Table and key are identifiers checked by IDENT_RE. */
function fillStatement(table: string, where: string) {
  return sql.raw(`
    UPDATE kortix.${table} t
       SET workspace_id = w.workspace_id
      FROM kortix.workspaces w
     WHERE w.legacy_account_id = t.account_id
       AND w.lifecycle <> 'tombstone'
       AND NOT w.split_pending
       AND t.workspace_id IS NULL
       AND ${where}`);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One batch of one target, inside `tx`. Returns the rows written and the target after it. */
async function fillBatch(tx: Tx, target: WorkspaceIdFillTarget, batchRows: number): Promise<{ rows: number; next: WorkspaceIdFillTarget }> {
  if (target.walk === 'key') {
    const key = target.key!;
    const after = target.cursor === null ? 'true' : `t2.${key} > ${literal(target.cursor)}`;
    const [bound] = await tx.execute<{ last: string | null; n: number }>(sql.raw(`
      SELECT (array_agg(k::text ORDER BY k DESC))[1] AS last, count(*)::int AS n
        FROM (SELECT t2.${key} AS k FROM kortix.${target.table} t2 WHERE ${after} ORDER BY t2.${key} LIMIT ${batchRows}) s`));
    const n = Number(bound?.n ?? 0);
    if (n === 0 || bound?.last == null) return { rows: 0, next: { ...target, done: true } };
    const lower = target.cursor === null ? 'true' : `t.${key} > ${literal(target.cursor)}`;
    const updated = await tx.execute(fillStatement(target.table, `${lower} AND t.${key} <= ${literal(bound.last)}`));
    const rows = updated.count ?? 0;
    return { rows, next: { ...target, cursor: bound.last, rows: target.rows + rows, done: n < batchRows } };
  }
  const [size] = await tx.execute<{ pages: number; tuples: number; blocks: number }>(sql.raw(`
    SELECT greatest(c.relpages, 1)::bigint AS pages, greatest(c.reltuples, 0)::bigint AS tuples,
           (pg_relation_size(c.oid) / current_setting('block_size')::bigint)::bigint AS blocks
      FROM pg_class c WHERE c.oid = 'kortix.${target.table}'::regclass`));
  const blocks = Number(size?.blocks ?? 0);
  const start = Number(target.cursor ?? 0);
  if (start >= blocks) {
    // Rows written after the plan read the size sit past the last range.
    const updated = await tx.execute(fillStatement(target.table, `t.ctid >= '(${start},0)'::tid`));
    const rows = updated.count ?? 0;
    return { rows, next: { ...target, rows: target.rows + rows, done: true } };
  }
  const perBlock = Math.max(1, Number(size!.tuples) / Number(size!.pages));
  const step = Math.max(1, Math.floor(batchRows / perBlock));
  const end = start + step;
  const updated = await tx.execute(
    fillStatement(target.table, `t.ctid >= '(${start},0)'::tid AND t.ctid < '(${end},0)'::tid`),
  );
  const rows = updated.count ?? 0;
  return { rows, next: { ...target, cursor: String(end), rows: target.rows + rows } };
}

async function saveProgress(tx: Tx, progress: WorkspaceIdFillProgress): Promise<void> {
  await tx
    .insert(platformSettings)
    .values({ key: WORKSPACE_ID_FILL_PROGRESS_KEY, value: progress, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: progress, updatedAt: new Date() } });
}

/**
 * One tick of the job: one batch, or nothing while paused or finished. The
 * worker waits `nextDelayMs` before the next tick.
 */
export async function runWorkspaceIdFillTick(now: () => Date = () => new Date()): Promise<WorkspaceIdFillTick> {
  const control = await workspaceIdFillControl();
  if (control.paused) return { state: 'paused', nextDelayMs: WORKSPACE_ID_FILL_IDLE_MS };
  let progress = await workspaceIdFillProgress();
  if (progress?.finished_at) return { state: 'finished', nextDelayMs: WORKSPACE_ID_FILL_IDLE_MS };
  if (!progress) {
    const at = now().toISOString();
    progress = { started_at: at, updated_at: at, finished_at: null, rows: 0, batches: 0, targets: await buildPlan() };
  }
  const index = progress.targets.findIndex((target) => !target.done);
  if (index === -1) {
    const finished = { ...progress, updated_at: now().toISOString(), finished_at: now().toISOString() };
    await db.transaction((tx) => saveProgress(tx, finished));
    logger.info('[workspace-id-fill] finished', { rows: finished.rows, batches: finished.batches, tables: finished.targets.length });
    return { state: 'finished', nextDelayMs: WORKSPACE_ID_FILL_IDLE_MS };
  }
  const target = progress.targets[index]!;
  const base = progress;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '60s'`);
    const batch = await fillBatch(tx, target, control.batchRows);
    const targets = base.targets.map((t, i) => (i === index ? batch.next : t));
    await saveProgress(tx, {
      ...base,
      updated_at: now().toISOString(),
      rows: base.rows + batch.rows,
      batches: base.batches + 1,
      targets,
    });
    return batch;
  });
  return { state: 'filled', table: target.table, rows: result.rows, nextDelayMs: control.pauseMs };
}
