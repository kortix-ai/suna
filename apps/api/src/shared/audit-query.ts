import { type Database, auditEvents, auditEventsAll } from '@kortix/db';
import { and, asc, eq, gt, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { isUuid } from './validate';

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type AuditEventRow = typeof auditEvents.$inferSelect;

export function parseAuditInstant(value: string | null, name: string): Date | null {
  if (value === null) return null;
  if (!ISO_INSTANT_RE.test(value)) throw new Error(`${name} must be an ISO-8601 instant`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be an ISO-8601 instant`);
  return parsed;
}

export function parseAuditLimit(value: string | null, fallback = 50, maximum = 200): number {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`limit must be an integer from 1 to ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`limit must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

export function parseAuditCursor(
  value: string | null,
): { occurredAt: Date; eventId: string } | null {
  if (value === null) return null;
  const separator = value.indexOf('|');
  if (separator <= 0 || separator !== value.lastIndexOf('|')) throw new Error('cursor is invalid');
  const instant = value.slice(0, separator);
  const eventId = value.slice(separator + 1);
  const occurredAt = parseAuditInstant(instant, 'cursor timestamp');
  if (!occurredAt || !isUuid(eventId)) throw new Error('cursor is invalid');
  return { occurredAt, eventId };
}

/**
 * Build a stable keyset predicate without losing PostgreSQL microseconds.
 *
 * Drizzle maps `timestamptz` to JavaScript `Date`, so a value such as
 * `...00.000123Z` becomes `...00.000Z` in the public cursor. Comparing the
 * database column directly with that rounded value selects the cursor row
 * again. Resolve the immutable cursor event by primary key to recover its exact
 * stored timestamp. The fallback preserves the accepted cursor contract for a
 * syntactically valid cursor whose event is no longer available.
 */
export function buildAuditCursorCondition(
  cursor: { occurredAt: Date; eventId: string },
  accountId: string,
  direction: 'ascending' | 'descending',
): SQL {
  // The stored instant lies in [cursor, cursor + 1 ms): JavaScript truncates it to the
  // millisecond. Bounding the lookup by that window lets the partitioned table prune to
  // one weekly partition (two at a boundary) and use the (event_id, occurred_at) key; a
  // lookup by event_id alone probes the primary key of every partition.
  const instant = cursor.occurredAt.toISOString();
  const exactOccurredAt = sql`coalesce(
    (
      select cursor_event.occurred_at
      from kortix.audit_events_all as cursor_event
      where cursor_event.event_id = ${cursor.eventId}::uuid
        and cursor_event.account_id = ${accountId}::uuid
        and cursor_event.occurred_at >= ${instant}::timestamptz
        and cursor_event.occurred_at < ${instant}::timestamptz + interval '1 millisecond'
    ),
    ${instant}::timestamptz
  )`;
  return direction === 'ascending'
    ? sql`(${auditEventsAll.occurredAt}, ${auditEventsAll.eventId}) > (${exactOccurredAt}, ${cursor.eventId}::uuid)`
    : sql`(${auditEventsAll.occurredAt}, ${auditEventsAll.eventId}) < (${exactOccurredAt}, ${cursor.eventId}::uuid)`;
}

export function parseAuditSessionCursor(
  value: string | null,
): { sequence: number; eventId: string } | null {
  if (value === null) return null;
  const match = /^(\d+)\|([0-9a-f-]+)$/i.exec(value);
  const eventId = match?.[2];
  if (!eventId || !isUuid(eventId)) throw new Error('cursor is invalid');
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('cursor is invalid');
  return { sequence, eventId };
}

/**
 * One page of a session's audit log, in a stable total order and without a lock.
 *
 * Two groups, in this order:
 *  1. rows with a `session_sequence` (written before the sequence allocator left the
 *     ingest path), ascending by (session_sequence, event_id);
 *  2. every later row, which has NO sequence, ascending by event_id. The id is a
 *     UUIDv7 (migration 20261001222932237): time-ordered, and ordered inside one
 *     INSERT statement, so this is creation order.
 * That is `ORDER BY session_sequence ASC NULLS LAST, event_id` and it walks
 * `idx_audit_events_session_sequence` (session_id, session_sequence, event_id) in
 * both groups. One query per group, not one query with an OR keyset: an OR over the
 * two groups cannot use the index order, and a session holds up to 1.7M rows.
 *
 * The cursor stays `<sequence>|<event_id>`. Sequence `0` means "the sequenced group
 * is exhausted; resume the unsequenced group after this event". Real sequences start
 * at 1, so `0` is free.
 */
export async function readSessionAuditEvents(
  database: Pick<Database, 'select'>,
  sessionId: string,
  cursor: { sequence: number; eventId: string } | null,
  limit: number,
): Promise<{ rows: AuditEventRow[]; nextCursor: string | null }> {
  const take = limit + 1;
  const rows: AuditEventRow[] = [];
  if (!cursor || cursor.sequence > 0) {
    // A row comparison is one index range; the `a > x OR (a = x AND b > y)` form
    // plans as BitmapOr + Sort and re-sorts the rest of a 1.6M-row session per page.
    const after = cursor
      ? sql`(${auditEventsAll.sessionSequence}, ${auditEventsAll.eventId}) > (${cursor.sequence}, ${cursor.eventId}::uuid)`
      : undefined;
    rows.push(
      ...(await database
        .select()
        .from(auditEventsAll)
        .where(and(eq(auditEventsAll.sessionId, sessionId), isNotNull(auditEventsAll.sessionSequence), after))
        .orderBy(asc(auditEventsAll.sessionSequence), asc(auditEventsAll.eventId))
        .limit(take)),
    );
  }
  if (rows.length < take) {
    const afterId = cursor && cursor.sequence === 0 ? cursor.eventId : null;
    rows.push(
      ...(await database
        .select()
        .from(auditEventsAll)
        .where(
          and(
            eq(auditEventsAll.sessionId, sessionId),
            isNull(auditEventsAll.sessionSequence),
            afterId ? gt(auditEventsAll.eventId, afterId) : undefined,
          ),
        )
        .orderBy(asc(auditEventsAll.sessionSequence), asc(auditEventsAll.eventId))
        .limit(take - rows.length)),
    );
  }
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > limit && last ? `${last.sessionSequence ?? 0}|${last.eventId}` : null,
  };
}

export function serializeAuditEvent(row: AuditEventRow, names?: Map<string, string>) {
  return {
    event_id: row.eventId,
    occurred_at: row.occurredAt.toISOString(),
    account_id: row.accountId,
    project_id: row.projectId,
    session_id: row.sessionId,
    runtime_session_id: row.runtimeSessionId,
    opencode_session_id: row.runtimeSessionId,
    turn_id: row.turnId,
    message_id: row.messageId,
    tool_call_id: row.toolCallId,
    execution_id: row.executionId,
    /** @deprecated Set only on rows written before 2026-10; NULL for new rows. */
    session_sequence: row.sessionSequence,
    actor_user_id: row.actorUserId,
    actor_type: row.actorType,
    agent_id: row.agentId,
    agent_name: row.agentName,
    initiator_actor_type: row.initiatorActorType,
    initiator_actor_id: row.initiatorActorId,
    on_behalf_of_user_id: row.onBehalfOfUserId ?? null,
    parent_event_id: row.parentEventId,
    delegation_depth: row.delegationDepth,
    source: row.source,
    authoritative_source: row.authoritativeSource,
    /** @deprecated Self-reported and no longer written; NULL for new rows. Use `credential_kind`. */
    client_reported_source: row.clientReportedSource,
    credential_kind: row.credentialKind,
    credential_id: row.credentialId,
    credential_name: names?.get(`${row.credentialKind}:${row.credentialId}`) ?? null,
    outcome: row.outcome,
    action: row.action,
    phase: row.phase,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    http_status: row.httpStatus,
    duration_ms: row.durationMs,
    request_id: row.requestId,
    trace_id: row.traceId,
    correlation_id: row.correlationId,
    causation_id: row.causationId,
    source_ledger: row.sourceLedger,
    source_record_id: row.sourceRecordId,
    source_revision: row.sourceRevision,
    input_summary: row.inputSummary,
    output_summary: row.outputSummary,
    input_sha256: row.inputSha256,
    output_sha256: row.outputSha256,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    /** @deprecated The hash chain left ingestion (2026-10); NULL for new rows. */
    integrity_previous_hash: row.integrityPreviousHash,
    /** @deprecated NULL for new rows. */
    integrity_hash: row.integrityHash,
    before: row.before,
    after: row.after,
    ip: row.ip,
    user_agent: row.userAgent,
    metadata: row.metadata,
  };
}
