// Pure query-shaping for the account audit log — the one piece of logic
// shared by the list (cursor-paginated) and export (CSV/JSONL) endpoints.
// Kept in its own module with ZERO heavy imports so it's trivially unit-
// testable (no config/db/openapi bootstrap); `accounts/audit.ts` re-exports
// it. What you see in the viewer is exactly what export gives you.
//
// Index-backed where it matters: idx_audit_events_actor_time (actor + since).
// `resource_type` has no index: it is matched with LIKE 'x%' under an account
// predicate, and the account_time index serves that.

import { auditEventsAll } from '@kortix/db';
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
  /** Trusted, server-derived source (`human`, `agent`, `api_key`, ...). */
  source?: string | null;
  /** What the API authenticated: `browser_session`, `personal_access_token`, ... */
  credentialKind?: string | null;
  phase?: string | null;
  outcome?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
}

/** The first day audit rows can carry `credential_kind` (migration 20260930024523072). */
const CREDENTIAL_KIND_SINCE = new Date('2026-09-30T00:00:00Z');

export function buildFilters(accountId: string, input: AuditFilterInput): SQL[] {
  const conditions: SQL[] = [eq(auditEventsAll.accountId, accountId)];
  // `or`/`and` are typed `SQL | undefined` in drizzle (a 0-arg call is
  // meaningless), so push through a guard rather than non-null-assert.
  const push = (...sqls: Array<SQL | undefined>) => {
    for (const s of sqls) if (s) conditions.push(s);
  };

  if (input.actor) {
    push(eq(auditEventsAll.actorUserId, input.actor));
  }
  if (input.projectId) push(eq(auditEventsAll.projectId, input.projectId));
  if (input.sessionId) push(eq(auditEventsAll.sessionId, input.sessionId));
  if (input.actorType) push(eq(auditEventsAll.actorType, input.actorType));
  if (input.source) push(eq(auditEventsAll.authoritativeSource, input.source));
  if (input.credentialKind) {
    // credential_kind is NULL on every row written before it existed, so no
    // older row can match. The floor keeps an unindexed filter from scanning
    // that whole history (it ran into the 25 s request deadline on dev).
    push(eq(auditEventsAll.credentialKind, input.credentialKind), gte(auditEventsAll.occurredAt, CREDENTIAL_KIND_SINCE));
  }
  if (input.phase) push(eq(auditEventsAll.phase, input.phase));
  if (input.outcome) push(eq(auditEventsAll.outcome, input.outcome));
  if (input.requestId) push(eq(auditEventsAll.requestId, input.requestId));
  if (input.correlationId) push(eq(auditEventsAll.correlationId, input.correlationId));

  if (input.actionPrefix) {
    // `computer.*` was the pre-profile audit namespace. Computer operations are
    // connector activity now. Keep historical rows inside the Connectors filter
    // while every new writer emits `connector.computer.*`.
    if (input.actionPrefix === 'connector.') {
      push(or(like(auditEventsAll.action, 'connector.%'), like(auditEventsAll.action, 'computer.%')));
    } else {
      push(
        input.actionPrefix.includes('.') && !input.actionPrefix.endsWith('.')
          ? or(
              eq(auditEventsAll.action, input.actionPrefix),
              like(auditEventsAll.action, `${input.actionPrefix}.%`),
            )
          : like(auditEventsAll.action, `${input.actionPrefix}%`),
      );
    }
  }

  if (input.resourceType) {
    // Prefix match so a caller can pass "project" and catch project,
    // project_session, etc. Plain `like` (case-sensitive by convention —
    // resource types are snake_case identifiers).
    push(like(auditEventsAll.resourceType, `${input.resourceType}%`));
  }

  if (input.sinceRaw) {
    const since = new Date(input.sinceRaw);
    if (!Number.isNaN(since.getTime())) push(gte(auditEventsAll.occurredAt, since));
  }
  if (input.untilRaw) {
    const until = new Date(input.untilRaw);
    if (!Number.isNaN(until.getTime())) push(lte(auditEventsAll.occurredAt, until));
  }

  if (input.q) {
    const term = `%${input.q}%`;
    // OR across the three text columns a human actually searches by. ILIKE so
    // it's case-insensitive (audit actions are lowercase by convention, but
    // resource ids / user-supplied names are not).
    push(
      or(
        ilike(auditEventsAll.action, term),
        ilike(auditEventsAll.resourceType, term),
        ilike(auditEventsAll.resourceId, term),
        ilike(auditEventsAll.sessionId, term),
        ilike(auditEventsAll.requestId, term),
        ilike(auditEventsAll.traceId, term),
        ilike(auditEventsAll.correlationId, term),
        sql`${auditEventsAll.projectId}::text ilike ${term}`,
      ),
    );
  }
  return conditions;
}
