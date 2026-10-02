/**
 * One page of the account audit export, ascending by (occurred_at, event_id), across the archive
 * and PostgreSQL.
 *
 * A week is served from S3 only when its chunk is archived AND PostgreSQL no longer holds it
 * (the partition is detached or dropped, and the legacy table is gone). Otherwise PostgreSQL
 * serves it, so no row appears twice and none is missed, at every instant of the archive job:
 * its removal steps flip that catalog fact atomically (see archive.ts). Archived weeks are always
 * older than what PostgreSQL still holds, so the page is archive rows first, then PostgreSQL rows.
 * The cursor of an archived row keeps microseconds (`...123456Z|<event_id>`).
 */
import { type Database, auditEvents, auditEventsAll } from '@kortix/db';
import { and, asc, getTableColumns, sql } from 'drizzle-orm';
import { type AuditFilterInput, buildFilters } from '../../accounts/audit-filters';
import { type AuditEventRow, buildAuditCursorCondition } from '../audit-query';
import { decodeRows, weekEnd, weekStartOf } from './format';
import { normalizeInstant, rowMatches } from './row-filter';

export interface ArchiveReader {
  list(prefix: string): Promise<Array<{ key: string }>>;
  getBytes(key: string): Promise<Uint8Array | null>;
}

export interface ExportCursor {
  occurredAt: Date;
  eventId: string;
  instant: string;
}

export interface ExportPageInput {
  accountId: string;
  filters: AuditFilterInput;
  cursor: ExportCursor | null;
  limit: number;
}

const rows = <T>(result: unknown): T[] => Array.from(result as Iterable<T>);
const KEY_RE = /\/(\d{4}-\d{2}-\d{2})\.(\d{3})\.jsonl\.gz$/;

/** Weeks whose rows PostgreSQL no longer holds, from `from` (inclusive) on, oldest first. */
async function archivedWeeks(db: Pick<Database, 'execute'>, fromWeek: string): Promise<string[]> {
  return rows<{ week: string }>(
    await db.execute(sql`
      SELECT c.week_start::text AS week
        FROM kortix.audit_archive_chunks c
       WHERE c.status IN ('archived', 'removed')
         AND c.week_start >= ${fromWeek}::date
         AND to_regclass('kortix.audit_events_legacy') IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhrelid
            WHERE i.inhparent = 'kortix.audit_events'::regclass
              AND p.relname = 'audit_events_p' || to_char(c.week_start, 'YYYYMMDD'))
       ORDER BY c.week_start`),
  ).map((r) => r.week);
}

const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const COLUMN_BY_NAME = new Map(Object.entries(getTableColumns(auditEvents)).map(([key, column]) => [column.name, key]));

/** An archived JSON row as the `AuditEventRow` the serializers expect. */
export function archiveRowToEvent(raw: Record<string, unknown>): AuditEventRow {
  const event: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    event[COLUMN_BY_NAME.get(name) ?? camel(name)] = name === 'occurred_at' ? new Date(String(value)) : value;
  }
  return event as AuditEventRow;
}

export async function readExportPage(
  deps: { db: Pick<Database, 'execute' | 'select'>; store: ArchiveReader | null },
  input: ExportPageInput,
): Promise<{ rows: AuditEventRow[]; nextCursor: string | null }> {
  const { db, store } = deps;
  const want = input.limit + 1;
  const found: Array<{ event: AuditEventRow; cursor: string }> = [];
  const cursorKey = input.cursor ? `${normalizeInstant(input.cursor.instant)}|${input.cursor.eventId}` : null;

  if (store) {
    const startWeek = weekStartOf(input.cursor?.occurredAt ?? new Date(0));
    const weeks = (await archivedWeeks(db, startWeek)).filter((week) => {
      if (input.filters.untilRaw && new Date(`${week}T00:00:00Z`) > new Date(input.filters.untilRaw)) return false;
      if (input.filters.sinceRaw && weekEnd(week) <= new Date(input.filters.sinceRaw)) return false;
      return true;
    });
    let keys: string[] | null = null;
    for (const week of weeks) {
      if (found.length >= want) break;
      keys ??= (await store.list(`audit/${input.accountId}/`)).map((o) => o.key);
      const parts = keys.filter((key) => KEY_RE.exec(key)?.[1] === week).sort();
      for (const key of parts) {
        const bytes = await store.getBytes(key);
        if (!bytes) throw new Error(`audit archive object ${key} is missing`);
        for (const raw of decodeRows(bytes)) {
          if (found.length >= want) break;
          if (!rowMatches(raw, input.accountId, input.filters)) continue;
          const at = normalizeInstant(String(raw.occurred_at));
          const rowKey = `${at}|${raw.event_id}`;
          if (cursorKey && rowKey <= cursorKey) continue;
          found.push({ event: archiveRowToEvent(raw), cursor: rowKey });
        }
      }
    }
  }

  if (found.length < want) {
    const conditions = buildFilters(input.accountId, input.filters);
    if (input.cursor) conditions.push(buildAuditCursorCondition(input.cursor, input.accountId, 'ascending'));
    const fetched = await db
      .select()
      .from(auditEventsAll)
      .where(and(...conditions))
      .orderBy(asc(auditEventsAll.occurredAt), asc(auditEventsAll.eventId))
      .limit(want - found.length);
    for (const event of fetched) found.push({ event, cursor: `${event.occurredAt.toISOString()}|${event.eventId}` });
  }

  const hasMore = found.length > input.limit;
  const page = hasMore ? found.slice(0, input.limit) : found;
  return { rows: page.map((p) => p.event), nextCursor: hasMore ? (page.at(-1)?.cursor ?? null) : null };
}
