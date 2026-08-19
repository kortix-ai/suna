// Pure query-shaping for the account audit log — the one piece of logic
// shared by the list (cursor-paginated) and export (CSV/JSONL) endpoints.
// Kept in its own module with ZERO heavy imports so it's trivially unit-
// testable (no config/db/openapi bootstrap); `accounts/audit.ts` re-exports
// it. What you see in the viewer is exactly what export gives you.
//
// Index-backed where it matters: idx_audit_events_actor_time (actor + since)
// and idx_audit_events_resource (resource_type).

import { auditEvents } from '@kortix/db';
import { type SQL, eq, gte, ilike, like, lte, or, sql } from 'drizzle-orm';

export interface AuditFilterInput {
  /** actor user_id, or null for "everyone". */
  actor: string | null;
  /** action prefix (e.g. "iam.group"); null = no action filter. */
  actionPrefix: string | null;
  /** resource_type prefix (e.g. "project_session"); null = any. */
  resourceType: string | null;
  /** ISO datetime — events at or after; null = unbounded. */
  sinceRaw: string | null;
  /** ISO datetime — events at or before; null = unbounded. */
  untilRaw: string | null;
  /** Case-insensitive substring over action + resource_type + resource_id. */
  q: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  actorType?: string | null;
  source?: string | null;
  phase?: string | null;
  outcome?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
}

export function buildFilters(accountId: string, input: AuditFilterInput): SQL[] {
  const conditions: SQL[] = [eq(auditEvents.accountId, accountId)];
  // `or`/`and` are typed `SQL | undefined` in drizzle (a 0-arg call is
  // meaningless), so push through a guard rather than non-null-assert.
  const push = (...sqls: Array<SQL | undefined>) => {
    for (const s of sqls) if (s) conditions.push(s);
  };

  if (input.actor) {
    push(eq(auditEvents.actorUserId, input.actor));
  }
  if (input.projectId) push(eq(auditEvents.projectId, input.projectId));
  if (input.sessionId) push(eq(auditEvents.sessionId, input.sessionId));
  if (input.actorType) push(eq(auditEvents.actorType, input.actorType));
  if (input.source) {
    // `source` is the trusted server-derived execution source. CLI/mobile/web
    // are client-reported surfaces and never overwrite it. One ergonomic
    // filter matches either field so `source=cli` remains useful without
    // trusting the client as provenance.
    push(
      or(
        eq(auditEvents.authoritativeSource, input.source),
        eq(auditEvents.clientReportedSource, input.source),
      ),
    );
  }
  if (input.phase) push(eq(auditEvents.phase, input.phase));
  if (input.outcome) push(eq(auditEvents.outcome, input.outcome));
  if (input.requestId) push(eq(auditEvents.requestId, input.requestId));
  if (input.correlationId) push(eq(auditEvents.correlationId, input.correlationId));

  if (input.actionPrefix) {
    // `computer.*` was the pre-profile audit namespace. Computer operations are
    // connector activity now. Keep historical rows inside the Connectors filter
    // while every new writer emits `connector.computer.*`.
    if (input.actionPrefix === 'connector.') {
      push(or(like(auditEvents.action, 'connector.%'), like(auditEvents.action, 'computer.%')));
    } else {
      push(
        input.actionPrefix.includes('.') && !input.actionPrefix.endsWith('.')
          ? or(
              eq(auditEvents.action, input.actionPrefix),
              like(auditEvents.action, `${input.actionPrefix}.%`),
            )
          : like(auditEvents.action, `${input.actionPrefix}%`),
      );
    }
  }

  if (input.resourceType) {
    // Prefix match so a caller can pass "project" and catch project,
    // project_session, etc. Plain `like` (case-sensitive by convention —
    // resource types are snake_case identifiers).
    push(like(auditEvents.resourceType, `${input.resourceType}%`));
  }

  if (input.sinceRaw) {
    const since = new Date(input.sinceRaw);
    if (!Number.isNaN(since.getTime())) push(gte(auditEvents.occurredAt, since));
  }
  if (input.untilRaw) {
    const until = new Date(input.untilRaw);
    if (!Number.isNaN(until.getTime())) push(lte(auditEvents.occurredAt, until));
  }

  if (input.q) {
    const term = `%${input.q}%`;
    // OR across the three text columns a human actually searches by. ILIKE so
    // it's case-insensitive (audit actions are lowercase by convention, but
    // resource ids / user-supplied names are not).
    push(
      or(
        ilike(auditEvents.action, term),
        ilike(auditEvents.resourceType, term),
        ilike(auditEvents.resourceId, term),
        ilike(auditEvents.sessionId, term),
        ilike(auditEvents.requestId, term),
        ilike(auditEvents.traceId, term),
        ilike(auditEvents.correlationId, term),
        sql`${auditEvents.projectId}::text ilike ${term}`,
      ),
    );
  }
  return conditions;
}
