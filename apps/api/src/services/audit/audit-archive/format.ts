/**
 * The archive's object layout and encoding. Pure: no database, no S3.
 *
 * One object family per (account, week): `audit/<account_id>/<yyyy>/<week-start>.<part>.jsonl.gz`,
 * rows ascending by (occurred_at, event_id), at most ARCHIVE_PART_ROWS per part. A reader lists
 * `audit/<account_id>/` and picks weeks by file name. Weeks start Monday 00:00 UTC, the same
 * boundaries as the PostgreSQL partitions. Rows without an account go under `_none`.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const DAY_MS = 86_400_000;
/** Postgres keeps this long; older weeks are archived and their partition dropped. */
export const HOT_DAYS = 90;
/** Privacy policy: application logs are kept up to 365 days. */
export const RETENTION_DAYS = 365;
export const ARCHIVE_PART_ROWS = 100_000;

/** `yyyy-mm-dd` of the Monday (UTC) of the week containing `at`. */
export function weekStartOf(at: Date): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

export function weekStartDate(weekStart: string): Date {
  return new Date(`${weekStart}T00:00:00.000Z`);
}

/** First instant after the week. */
export function weekEnd(weekStart: string): Date {
  return new Date(weekStartDate(weekStart).getTime() + 7 * DAY_MS);
}

export function archiveObjectKey(accountId: string | null, weekStart: string, part: number): string {
  return `audit/${accountId ?? '_none'}/${weekStart.slice(0, 4)}/${weekStart}.${String(part).padStart(3, '0')}.jsonl.gz`;
}

export function manifestKey(weekStart: string): string {
  return `audit/_manifest/${weekStart}.json`;
}

/** Object Lock date: 365 days after the last instant any row of the week can have. */
export function retainUntil(weekStart: string): Date {
  return new Date(weekEnd(weekStart).getTime() + RETENTION_DAYS * DAY_MS);
}

export function isReadyToArchive(weekStart: string, now: Date): boolean {
  return weekEnd(weekStart).getTime() < now.getTime() - HOT_DAYS * DAY_MS;
}

/** Past (or within a day of) the retention end: dropped, never exported. */
export function isExpired(weekStart: string, now: Date): boolean {
  return retainUntil(weekStart).getTime() <= now.getTime() + DAY_MS;
}

export interface EncodedRows {
  bytes: Buffer;
  sha256: string;
  rows: number;
}

/** Deterministic: equal lines give equal bytes, so a retry can be compared with the stored object. */
export function encodeRows(lines: string[]): EncodedRows {
  const bytes = gzipSync(`${lines.join('\n')}\n`, { level: 9 });
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), rows: lines.length };
}

export function decodeRows(bytes: Uint8Array): Array<Record<string, unknown>> {
  return gunzipSync(bytes)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
