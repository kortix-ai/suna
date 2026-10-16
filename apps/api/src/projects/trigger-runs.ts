/**
 * Trigger run history reads (KRTX-1743). A run is one row of
 * `project_trigger_executions`; this module lists runs, loads one for replay,
 * and serializes them onto the wire. Writes live in trigger-execution-store.ts.
 */
import type { TriggerRun } from '@kortix/api-contract';
import { gatewayRequestLogs, projectTriggerExecutions } from '@kortix/db';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { isSecretKey } from '../connectors/args-preview';
import { db } from '../shared/db';
import { totalSpendSql } from '../shared/llm-spend';
import { loadVisibleSessionsForList } from './lib/session-visibility';

export const TRIGGER_RUN_STATUSES = ['queued', 'running', 'fired', 'failed', 'skipped', 'rejected'] as const;
export type TriggerRunApiStatus = (typeof TRIGGER_RUN_STATUSES)[number];

/** DB status → API status. `requeued` is a create back on the lifecycle queue. */
const API_STATUS: Record<string, TriggerRunApiStatus> = {
  queued: 'queued',
  requeued: 'queued',
  running: 'running',
  succeeded: 'fired',
  dead_lettered: 'failed',
  failed: 'failed',
  skipped: 'skipped',
  rejected: 'rejected',
};

export function triggerRunApiStatus(dbStatus: string): TriggerRunApiStatus {
  return API_STATUS[dbStatus] ?? 'failed';
}

function dbStatusesFor(status: TriggerRunApiStatus): string[] {
  return Object.keys(API_STATUS).filter((key) => API_STATUS[key] === status);
}

const t = projectTriggerExecutions;
const g = gatewayRequestLogs;

// Drizzle renders a bare column unqualified inside a select field, so a
// correlated subquery names both tables' columns in full.
const run = (column: string) => sql.raw(`"kortix"."project_trigger_executions"."${column}"`);
const log = (column: string) => sql.raw(`"kortix"."gateway_request_logs"."${column}"`);

/** Ruling 4: LLM spend of the run's session inside `[started_at, ended_at or now]`. */
const costSql = sql<number | null>`case when ${run('session_id')} is null then null else (
  select ${totalSpendSql} from ${g}
   where ${log('project_id')} = ${run('project_id')}
     and ${log('session_id')} = ${run('session_id')}
     and ${log('created_at')} >= coalesce(${run('claimed_at')}, ${run('created_at')})
     and ${log('created_at')} <= coalesce(${run('run_ended_at')}, now())
) end`;

const runColumns = {
  row: t,
  // Full microsecond precision: a JS Date would truncate it and break the cursor.
  createdAtText: sql<string>`${t.createdAt}::text`,
  costUsd: costSql,
};

type RunRow = { row: typeof t.$inferSelect; createdAtText: string; costUsd: number | null };

function encodeCursor(row: RunRow | { createdAt: string; executionId: string }): string {
  const key = 'row' in row ? [row.createdAtText, row.row.executionId] : [row.createdAt, row.executionId];
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/** `created_at::text` as Postgres prints it: `2026-10-16 18:03:54.382+00`. */
const PG_TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

/** Null when the cursor is not one this module issued. */
export function decodeTriggerRunCursor(cursor: string): { createdAt: string; executionId: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, executionId] = parsed;
    if (typeof createdAt !== 'string' || !PG_TIMESTAMPTZ_TEXT.test(createdAt)) return null;
    // The regex admits month 13 or hour 25; Postgres would throw on those, so parse it too.
    const iso = createdAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    if (Number.isNaN(Date.parse(iso))) return null;
    if (typeof executionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(executionId)) return null;
    return { createdAt, executionId };
  } catch {
    return null;
  }
}

/** Every value under a credential-named key becomes `[redacted]`. The DB keeps the original. */
export function redactRunPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRunPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, isSecretKey(key) ? '[redacted]' : redactRunPayload(inner)]),
  );
}

export function serializeTriggerRun({ row, costUsd }: Pick<RunRow, 'row' | 'costUsd'>): TriggerRun {
  const status = triggerRunApiStatus(row.status);
  const startedAt = row.claimedAt ?? row.createdAt;
  // A run is open while it waits, runs, or its session's turn is still going.
  const open = status === 'queued' || status === 'running' || row.runStatus === 'running';
  const endedAt = open ? null : (row.runEndedAt ?? row.completedAt);
  return {
    run_id: row.executionId,
    slug: row.slug,
    source: row.source as TriggerRun['source'],
    status,
    run_status: (row.runStatus as TriggerRun['run_status']) ?? null,
    error: row.lastError,
    run_error: row.runError,
    session_id: row.sessionId,
    command_id: row.commandId,
    replay_of: row.replayOf,
    payload_verified: row.payloadVerified,
    payload: redactRunPayload(row.payload) as Record<string, unknown>,
    scheduled_for: row.scheduledFor.toISOString(),
    created_at: row.createdAt.toISOString(),
    started_at: startedAt.toISOString(),
    ended_at: endedAt?.toISOString() ?? null,
    duration_ms: endedAt ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : null,
    cost_usd: costUsd === null || costUsd === undefined ? null : Number(costUsd),
  };
}

/** At most this many pages are read to fill one visible page (ruling 6 hides some rows). */
const MAX_SCAN_PAGES = 5;

/**
 * Runs newest first, keyset-paged on `(created_at, execution_id)`. A run with a
 * session is listed only when the caller may open that session (ruling 6).
 */
export async function listVisibleTriggerRuns(input: {
  loaded: Parameters<typeof loadVisibleSessionsForList>[0];
  binding: string | null;
  slug?: string;
  status?: TriggerRunApiStatus;
  limit: number;
  cursor: { createdAt: string; executionId: string } | null;
}): Promise<{ runs: TriggerRun[]; next_cursor: string | null }> {
  const runs: TriggerRun[] = [];
  let cursor = input.cursor;
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const filters: SQL[] = [eq(t.projectId, input.loaded.row.projectId)];
    if (input.slug) filters.push(eq(t.slug, input.slug));
    if (input.status) filters.push(inArray(t.status, dbStatusesFor(input.status)));
    if (cursor) filters.push(sql`(${t.createdAt}, ${t.executionId}) < (${cursor.createdAt}::timestamptz, ${cursor.executionId}::uuid)`);
    const rows: RunRow[] = await db
      .select(runColumns)
      .from(t)
      .where(and(...filters))
      .orderBy(desc(t.createdAt), desc(t.executionId))
      .limit(input.limit + 1);
    const more = rows.length > input.limit;
    const batch = rows.slice(0, input.limit);
    const sessionIds = batch.flatMap((r) => (r.row.sessionId ? [r.row.sessionId] : []));
    const visible = await loadVisibleSessionsForList(input.loaded, sessionIds, input.binding, input.binding);
    for (const [index, r] of batch.entries()) {
      if (r.row.sessionId && !visible.has(r.row.sessionId)) continue;
      runs.push(serializeTriggerRun(r));
      if (runs.length === input.limit) {
        return { runs, next_cursor: more || index + 1 < batch.length ? encodeCursor(r) : null };
      }
    }
    if (!more) return { runs, next_cursor: null };
    const last = batch[batch.length - 1]!;
    cursor = { createdAt: last.createdAtText, executionId: last.row.executionId };
  }
  // The scan budget ran out on hidden rows: a short page that continues after the last scanned row.
  return { runs, next_cursor: cursor ? encodeCursor(cursor) : null };
}

/** One run of one trigger, unredacted, for replay. Null when it is not that trigger's. */
export async function loadTriggerRunForReplay(projectId: string, slug: string, runId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.projectId, projectId), eq(t.slug, slug), eq(t.executionId, runId)))
    .limit(1);
  return row ?? null;
}
