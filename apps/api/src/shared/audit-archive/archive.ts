/**
 * The audit archive job: export a week of `kortix.audit_events` to S3, verify it, then remove it
 * from PostgreSQL.
 *
 * Why: the table is partitioned by week and keeps 90 days hot. Older history is evidence the
 * product owes for 365 days (privacy policy), so it moves to an Object Lock bucket (tamper
 * evidence: COMPLIANCE retention until the week's end + 365 days) instead of staying in a 2 TB
 * btree. Order of a week, each step safe to repeat:
 *   1. export  one account at a time, rows ascending by (occurred_at, event_id), at most ARCHIVE_PART_ROWS per
 *              object, written once (If-None-Match) with Object Lock; S3 verifies each SHA-256;
 *   2. verify  count and an order-free checksum of event ids, streamed vs. a second query;
 *   3. record  `audit_archive_chunks.status = archived` (PostgreSQL still serves the week);
 *   4. remove  DETACH + DROP the partition after re-counting it; status removed. DETACH takes
 *              ACCESS EXCLUSIVE on the parent for an instant (DETACH ... CONCURRENTLY is refused
 *              while the table has a default partition), so it runs under a 1 s lock_timeout and
 *              retries; one partition a week.
 * The pre-partitioning table (audit_events_legacy) cannot lose rows one by one (145M deletes is a
 * WAL storm), so it is exported week by week and dropped whole, once every row is older than 90
 * days (`retireLegacy`).
 *
 * Bounded work: reads are keyset batches of `batchRows` (5,000) capped at `rowsPerSecond`
 * (20,000), one week at a time, within `budgetMs` (3 h) per tick.
 */
import type { Database } from '@kortix/db';
import { type SQL, sql } from 'drizzle-orm';
import type { ObjectLockMode } from '../../object-store/s3';
import {
  ARCHIVE_PART_ROWS,
  HOT_DAYS,
  archiveObjectKey,
  encodeRows,
  isExpired,
  isReadyToArchive,
  manifestKey,
  retainUntil,
  weekEnd,
} from './format';

export interface ArchiveStore {
  putLocked(input: { key: string; body: Buffer; contentType: string; retainUntil: Date; mode: ObjectLockMode }): Promise<'created' | 'exists'>;
  checksum(key: string): Promise<string | null>;
}

type Db = Pick<Database, 'execute' | 'transaction'>;

export interface ArchiveDeps {
  db: Db;
  store: ArchiveStore;
  mode: ObjectLockMode;
  rowsPerSecond: number;
  batchRows?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

const DAY_MS = 86_400_000;
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const rows = <T>(result: unknown): T[] => Array.from(result as Iterable<T>);
/** A SQL date[] literal: drizzle expands a JS array into a row, which PostgreSQL cannot cast. */
const dateArray = (weeks: string[]) =>
  weeks.length ? sql`ARRAY[${sql.join(weeks.map((w) => sql`${w}::date`), sql`, `)}]::date[]` : sql`ARRAY[]::date[]`;
const base64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

function assertWeek(week: string): string {
  if (!WEEK_RE.test(week)) throw new Error(`invalid week ${week}`);
  return week;
}
const partitionName = (week: string) => `audit_events_p${assertWeek(week).replaceAll('-', '')}`;

/** Read-only statements that scan a week need minutes, not the pool's seconds. */
async function longRead<T>(db: Db, run: (tx: Pick<Database, 'execute'>) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '30min'`);
    return run(tx);
  });
}

async function legacyExists(db: Db): Promise<boolean> {
  const [r] = rows<{ present: boolean }>(await db.execute(sql`SELECT to_regclass('kortix.audit_events_legacy') IS NOT NULL AS present`));
  return Boolean(r?.present);
}

async function partitionAttached(db: Db, week: string): Promise<boolean> {
  const [r] = rows<{ present: boolean }>(
    await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'kortix.audit_events'::regclass AND c.relname = ${partitionName(week)}) AS present`),
  );
  return Boolean(r?.present);
}

/**
 * The rows of one week, from the partition and (while it exists) the legacy table. `where` is
 * applied INSIDE each branch, so each branch is an index range scan over (account_id, occurred_at)
 * instead of a sort of the whole week.
 */
function weekSource(week: string, partition: boolean, legacy: boolean, where: SQL = sql`true`): SQL {
  const lo = `${assertWeek(week)} 00:00:00+00`;
  const hi = `${weekEnd(week).toISOString().slice(0, 10)} 00:00:00+00`;
  const parts: SQL[] = [];
  if (partition) parts.push(sql`SELECT * FROM ${sql.raw(`kortix.${partitionName(week)}`)} WHERE ${where}`);
  if (legacy) {
    parts.push(
      sql`SELECT * FROM kortix.audit_events_legacy WHERE occurred_at >= ${lo}::timestamptz AND occurred_at < ${hi}::timestamptz AND ${where}`,
    );
  }
  return parts.length ? sql.join(parts, sql` UNION ALL `) : sql`SELECT * FROM kortix.audit_events WHERE false`;
}

const CHK = sql.raw(`(('x' || substr(md5(s.event_id::text), 1, 15))::bit(60)::bigint)`);

interface ExportRow {
  line: string;
  account_id: string | null;
  at: string;
  id: string;
  chk: string;
}

export interface ManifestObject {
  key: string;
  account_id: string | null;
  part: number;
  rows: number;
  bytes: number;
  sha256: string;
  first_occurred_at: string;
  last_occurred_at: string;
}

export interface WeekExport {
  week: string;
  rows: number;
  legacyRows: number;
  objects: number;
  bytes: number;
  manifestKey: string;
  manifestSha256: string;
}

export async function exportWeek(deps: ArchiveDeps, week: string): Promise<WeekExport> {
  const { db, store, mode } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const batch = deps.batchRows ?? 5_000;
  const keepUntil = retainUntil(week);
  const partition = await partitionAttached(db, week);
  const legacy = await legacyExists(db);
  const source = weekSource(week, partition, legacy);

  await db.execute(sql`
    INSERT INTO kortix.audit_archive_chunks (week_start, status, retain_until)
    VALUES (${week}::date, 'exporting', ${keepUntil.toISOString()}::timestamptz)
    ON CONFLICT (week_start) DO UPDATE SET status = 'exporting', retain_until = EXCLUDED.retain_until, updated_at = now()`);

  const objects: ManifestObject[] = [];
  let totalRows = 0;
  let totalBytes = 0;
  let checksumSum = 0n;
  let current: { account: string | null; part: number; lines: string[]; first: string; last: string } | null = null;

  const flush = async () => {
    if (!current || current.lines.length === 0) return;
    const encoded = encodeRows(current.lines);
    const key = archiveObjectKey(current.account, week, current.part);
    await store.putLocked({ key, body: encoded.bytes, contentType: 'application/gzip', retainUntil: keepUntil, mode });
    // Whether created now or by an earlier attempt, S3 must hold exactly these bytes.
    if ((await store.checksum(key)) !== base64(encoded.sha256)) {
      throw new Error(`archive object ${key} does not match the exported rows (S3 checksum differs)`);
    }
    objects.push({
      key, account_id: current.account, part: current.part, rows: encoded.rows,
      bytes: encoded.bytes.length, sha256: encoded.sha256, first_occurred_at: current.first, last_occurred_at: current.last,
    });
    totalBytes += encoded.bytes.length;
    current = { ...current, part: current.part + 1, lines: [], first: '', last: '' };
  };

  const take = async (page: ExportRow[]) => {
    for (const row of page) {
      if (current && (current.account !== row.account_id || current.lines.length >= ARCHIVE_PART_ROWS)) {
        const sameAccount = current.account === row.account_id;
        await flush();
        if (!sameAccount) current = null;
      }
      current ??= { account: row.account_id, part: 0, lines: [], first: '', last: '' };
      if (current.lines.length === 0) current.first = row.at;
      current.lines.push(row.line);
      current.last = row.at;
      totalRows += 1;
      checksumSum += BigInt(row.chk);
    }
  };

  // One account at a time: its rows are one index range, already in (occurred_at, event_id) order.
  // The account list comes from one pass over the week (time-contiguous in the heap).
  const accounts = rows<{ account_id: string | null }>(
    await longRead(db, (tx) => tx.execute(sql`SELECT DISTINCT s.account_id::text AS account_id FROM (${source}) s ORDER BY 1`)),
  ).map((r) => r.account_id);
  const startedAt = Date.now();
  for (const account of accounts) {
    const accountWhere = account === null ? sql`account_id IS NULL` : sql`account_id = ${account}::uuid`;
    let cursor = null as { at: string; id: string } | null;
    for (;;) {
      const where = cursor
        ? sql`${accountWhere} AND (occurred_at, event_id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
        : accountWhere;
      const page: ExportRow[] = rows<ExportRow>(
        await db.execute(sql`
          -- occurred_at as fixed-width UTC microseconds: to_jsonb would print it in the session time zone.
          SELECT (to_jsonb(s) || jsonb_build_object('occurred_at', to_char(s.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))::text AS line,
                 s.account_id::text AS account_id, s.occurred_at::text AS at,
                 s.event_id::text AS id, ${CHK}::text AS chk
            FROM (${weekSource(week, partition, legacy, where)}) s
           ORDER BY s.occurred_at, s.event_id
           LIMIT ${batch}`),
      );
      if (page.length === 0) break;
      await take(page);
      const last: ExportRow = page[page.length - 1]!;
      cursor = { at: last.at, id: last.id };
      // Rate cap: rows read so far may not outrun rowsPerSecond. Sleep off what is owed, in lumps.
      const owedMs = (totalRows / deps.rowsPerSecond) * 1000 - (Date.now() - startedAt);
      if (owedMs > 5) await sleep(owedMs);
      if (page.length < batch) break;
    }
  }
  await flush();

  const [check] = rows<{ n: string; sum: string }>(
    await longRead(db, (tx) => tx.execute(sql`SELECT count(*)::text AS n, coalesce(sum(${CHK}), 0)::text AS sum FROM (${source}) s`)),
  );
  if (!check || BigInt(check.n) !== BigInt(totalRows) || BigInt(check.sum) !== checksumSum) {
    throw new Error(`export of ${week} does not match PostgreSQL: streamed ${totalRows} rows, database has ${check?.n}`);
  }
  const [legacyCount] = legacy
    ? rows<{ n: string }>(
        await longRead(db, (tx) =>
          tx.execute(sql`SELECT count(*)::text AS n FROM kortix.audit_events_legacy
                          WHERE occurred_at >= ${`${week}T00:00:00Z`}::timestamptz AND occurred_at < ${weekEnd(week).toISOString()}::timestamptz`),
        ),
      )
    : [{ n: '0' }];

  const manifest = JSON.stringify({
    version: 1, week_start: week, week_end: weekEnd(week).toISOString(), rows: totalRows,
    legacy_rows: Number(legacyCount?.n ?? 0), event_id_checksum: checksumSum.toString(),
    objects: objects.sort((a, b) => (a.key < b.key ? -1 : 1)),
  });
  const encodedManifest = Buffer.from(manifest);
  const manifestHash = (await import('node:crypto')).createHash('sha256').update(encodedManifest).digest('hex');
  const mKey = manifestKey(week);
  await store.putLocked({ key: mKey, body: encodedManifest, contentType: 'application/json', retainUntil: keepUntil, mode });
  if ((await store.checksum(mKey)) !== base64(manifestHash)) throw new Error(`manifest ${mKey} does not match`);

  await db.execute(sql`
    UPDATE kortix.audit_archive_chunks
       SET status = 'archived', row_count = ${totalRows}, legacy_row_count = ${Number(legacyCount?.n ?? 0)},
           object_count = ${objects.length}, byte_count = ${totalBytes}, manifest_key = ${mKey},
           manifest_sha256 = ${manifestHash}, archived_at = now(), updated_at = now()
     WHERE week_start = ${week}::date`);
  return { week, rows: totalRows, legacyRows: Number(legacyCount?.n ?? 0), objects: objects.length, bytes: totalBytes, manifestKey: mKey, manifestSha256: manifestHash };
}

/** Partition weeks of `kortix.audit_events` (the attached ones), oldest first, as `yyyy-mm-dd`. */
async function attachedWeeks(db: Db): Promise<string[]> {
  return rows<{ name: string }>(
    await db.execute(sql`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'kortix.audit_events'::regclass AND c.relname ~ '^audit_events_p[0-9]{8}$'
       ORDER BY c.relname`),
  ).map((r) => `${r.name.slice(-8, -4)}-${r.name.slice(-4, -2)}-${r.name.slice(-2)}`);
}

async function chunkStatus(db: Db, week: string): Promise<{ status: string; rowCount: number; legacyRowCount: number } | null> {
  const [r] = rows<{ status: string; rowCount: string; legacyRowCount: string }>(
    await db.execute(sql`SELECT status, row_count::text AS "rowCount", legacy_row_count::text AS "legacyRowCount"
                           FROM kortix.audit_archive_chunks WHERE week_start = ${week}::date`),
  );
  return r ? { status: r.status, rowCount: Number(r.rowCount), legacyRowCount: Number(r.legacyRowCount) } : null;
}

async function countPartition(db: Db, week: string): Promise<number> {
  const [r] = rows<{ n: string }>(
    await longRead(db, (tx) => tx.execute(sql`SELECT count(*)::text AS n FROM ${sql.raw(`kortix.${partitionName(week)}`)}`)),
  );
  return Number(r?.n ?? 0);
}

/** DETACH takes ACCESS EXCLUSIVE on the parent: never wait for it longer than a second, and retry. */
async function detachPartition(deps: ArchiveDeps, week: string): Promise<void> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.execute(sql.raw(`ALTER TABLE kortix.audit_events DETACH PARTITION kortix.${partitionName(week)}`));
      });
      return;
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
      if (code !== '55P03' || attempt >= 5) throw error;
      await sleep(2_000 * attempt);
    }
  }
}

/** Detach and drop one archived partition, after proving it still holds what was exported. */
async function removePartition(deps: ArchiveDeps, week: string, expectedRows: number): Promise<void> {
  const { db } = deps;
  const name = partitionName(week);
  if (await partitionAttached(db, week)) await detachPartition(deps, week);
  const held = await countPartition(db, week);
  if (held !== expectedRows) {
    // Rows arrived after the export. They are still in the detached table: keep it for an operator.
    deps.log?.('archive: detached partition holds rows that were not exported; NOT dropped', { week, held, expectedRows });
    throw new Error(`partition ${name} holds ${held} rows, archive has ${expectedRows}`);
  }
  await db.execute(sql.raw(`DROP TABLE kortix.${name}`));
  await db.execute(sql`UPDATE kortix.audit_archive_chunks SET status = 'removed', removed_at = now(), updated_at = now() WHERE week_start = ${week}::date`);
}

export interface TickResult {
  archived: string[];
  removed: string[];
  expired: string[];
  legacyRetired: boolean;
}

/**
 * One pass. Weeks are processed oldest first and the pass stops at `deadline`; whatever is left
 * runs on the next tick. Partitions are removed only once the legacy table is gone: a week's
 * legacy rows are exported with it, but cannot be deleted one by one (see the file header).
 */
export async function runArchivePass(deps: ArchiveDeps, deadline: number): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const result: TickResult = { archived: [], removed: [], expired: [], legacyRetired: false };
  const legacy = await legacyExists(deps.db);
  const weeks = new Set(await attachedWeeks(deps.db));
  if (legacy) {
    for (const r of rows<{ w: string }>(await deps.db.execute(sql`
      SELECT DISTINCT to_char(date_trunc('week', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS w FROM kortix.audit_events_legacy`))) {
      weeks.add(r.w);
    }
  }
  for (const week of [...weeks].sort()) {
    if (Date.now() > deadline) return result;
    if (!isReadyToArchive(week, now())) continue;
    const chunk = await chunkStatus(deps.db, week);
    if (isExpired(week, now()) && chunk?.status !== 'archived' && chunk?.status !== 'removed') {
      // Past the 365-day retention without an export: retention wins, the data is dropped.
      if (!legacy && (await partitionAttached(deps.db, week))) {
        deps.log?.('archive: week is past retention and was never exported; dropping', { week });
        await detachPartition(deps, week);
        await deps.db.execute(sql.raw(`DROP TABLE kortix.${partitionName(week)}`));
        await deps.db.execute(sql`INSERT INTO kortix.audit_archive_chunks (week_start, status, updated_at) VALUES (${week}::date, 'expired', now())
                                  ON CONFLICT (week_start) DO UPDATE SET status = 'expired', updated_at = now()`);
        result.expired.push(week);
      }
      continue;
    }
    if (chunk?.status !== 'archived' && chunk?.status !== 'removed') {
      await exportWeek(deps, week);
      result.archived.push(week);
    }
  }
  if (legacy) {
    result.legacyRetired = await retireLegacy(deps, now());
  }
  for (const week of await attachedWeeks(deps.db)) {
    if (Date.now() > deadline) break;
    const chunk = await chunkStatus(deps.db, week);
    if (chunk?.status === 'archived' && !(await legacyExists(deps.db))) {
      await removePartition(deps, week, chunk.rowCount - chunk.legacyRowCount);
      result.removed.push(week);
    }
  }
  return result;
}

/**
 * Drop the pre-partitioning table once every one of its rows is older than 90 days and every week
 * it covers is archived. One transaction: the view stops reading it, the partitions that also
 * hold rows of those weeks are detached and dropped (their rows are in the archive), the table
 * is dropped, the chunks are marked removed. A reader sees the archive and PostgreSQL swap at
 * the commit. Returns false while any week is still pending.
 */
export async function retireLegacy(deps: ArchiveDeps, now: Date): Promise<boolean> {
  const { db } = deps;
  if (!(await legacyExists(db))) return false;
  const [bounds] = rows<{ newest: string | null; total: string }>(
    await db.execute(sql`SELECT max(occurred_at)::text AS newest, count(*)::text AS total FROM kortix.audit_events_legacy`),
  );
  if (bounds?.newest && new Date(bounds.newest).getTime() >= now.getTime() - HOT_DAYS * DAY_MS) return false;
  const legacyWeeks = rows<{ w: string }>(
    await db.execute(sql`SELECT DISTINCT to_char(date_trunc('week', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS w FROM kortix.audit_events_legacy`),
  ).map((r) => r.w);
  let archivedLegacyRows = 0;
  for (const week of legacyWeeks) {
    const chunk = await chunkStatus(db, week);
    if (chunk?.status !== 'archived') return false;
    archivedLegacyRows += chunk.legacyRowCount;
  }
  const [live] = rows<{ n: string }>(await longRead(db, (tx) => tx.execute(sql`SELECT count(*)::text AS n FROM kortix.audit_events_legacy`)));
  if (Number(live?.n ?? -1) !== archivedLegacyRows) {
    deps.log?.('archive: legacy table changed since the export; not dropping', { live: live?.n, archivedLegacyRows });
    return false;
  }
  // Partitions that hold late rows of an archived week: drop them with the legacy table.
  const partitionWeeks: string[] = [];
  for (const week of await attachedWeeks(db)) {
    const chunk = await chunkStatus(db, week);
    if (chunk?.status === 'archived' && isReadyToArchive(week, now)) partitionWeeks.push(week);
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`CREATE OR REPLACE VIEW kortix.audit_events_all AS SELECT * FROM kortix.audit_events`);
    for (const week of partitionWeeks) {
      const chunk = await chunkStatus(tx as unknown as Db, week);
      const held = rows<{ n: string }>(await tx.execute(sql.raw(`SELECT count(*)::text AS n FROM kortix.${partitionName(week)}`)))[0]?.n;
      if (Number(held) !== (chunk?.rowCount ?? 0) - (chunk?.legacyRowCount ?? 0)) throw new Error(`partition for ${week} changed since the export`);
      await tx.execute(sql.raw(`ALTER TABLE kortix.audit_events DETACH PARTITION kortix.${partitionName(week)}`));
      await tx.execute(sql.raw(`DROP TABLE kortix.${partitionName(week)}`));
    }
    await tx.execute(sql`DROP TABLE kortix.audit_events_legacy`);
    await tx.execute(sql`UPDATE kortix.audit_archive_chunks SET status = 'removed', removed_at = now(), updated_at = now()
                          WHERE status = 'archived' AND (week_start = ANY(${dateArray(legacyWeeks)}) OR week_start = ANY(${dateArray(partitionWeeks)}))`);
  });
  return true;
}
