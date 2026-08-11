import { auditEvents } from '@kortix/db';
import { sql, type SQL } from 'drizzle-orm';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  if (!occurredAt || !UUID_RE.test(eventId)) throw new Error('cursor is invalid');
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
  const exactOccurredAt = sql`coalesce(
    (
      select cursor_event.occurred_at
      from kortix.audit_events as cursor_event
      where cursor_event.event_id = ${cursor.eventId}::uuid
        and cursor_event.account_id = ${accountId}::uuid
    ),
    ${cursor.occurredAt.toISOString()}::timestamptz
  )`;
  return direction === 'ascending'
    ? sql`(${auditEvents.occurredAt}, ${auditEvents.eventId}) > (${exactOccurredAt}, ${cursor.eventId}::uuid)`
    : sql`(${auditEvents.occurredAt}, ${auditEvents.eventId}) < (${exactOccurredAt}, ${cursor.eventId}::uuid)`;
}

export function parseAuditSessionCursor(
  value: string | null,
): { sequence: number; eventId: string } | null {
  if (value === null) return null;
  const match = /^(\d+)\|([0-9a-f-]+)$/i.exec(value);
  const eventId = match?.[2];
  if (!eventId || !UUID_RE.test(eventId)) throw new Error('cursor is invalid');
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('cursor is invalid');
  return { sequence, eventId };
}

export function serializeAuditEvent(row: AuditEventRow) {
  return {
    event_id: row.eventId,
    occurred_at: row.occurredAt.toISOString(),
    account_id: row.accountId,
    project_id: row.workspaceId,
    session_id: row.sessionId,
    opencode_session_id: row.opencodeSessionId,
    turn_id: row.turnId,
    message_id: row.messageId,
    tool_call_id: row.toolCallId,
    execution_id: row.executionId,
    session_sequence: row.sessionSequence,
    actor_user_id: row.actorUserId,
    actor_type: row.actorType,
    agent_id: row.agentId,
    agent_name: row.agentName,
    initiator_actor_type: row.initiatorActorType,
    initiator_actor_id: row.initiatorActorId,
    parent_event_id: row.parentEventId,
    delegation_depth: row.delegationDepth,
    source: row.source,
    authoritative_source: row.authoritativeSource,
    client_reported_source: row.clientReportedSource,
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
    integrity_previous_hash: row.integrityPreviousHash,
    integrity_hash: row.integrityHash,
    before: row.before,
    after: row.after,
    ip: row.ip,
    user_agent: row.userAgent,
    metadata: row.metadata,
  };
}
