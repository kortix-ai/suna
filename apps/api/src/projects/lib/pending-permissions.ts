/**
 * Permission asks kept beyond the sandbox (session-asks.ts has the model).
 *
 * The runtime relays every `ask` before anyone sees it (`POST /turn-permission`).
 * The row is the durable ask: it survives the box, the turn, and the call that
 * parked. A person decides it from Review or the session:
 *
 * - while the call still waits live, the decision goes to the runtime and the
 *   call runs (or is refused) in the same turn;
 * - once it parked, the decision is stored, and the agent hears it as a new
 *   message. An approval stays unconsumed until the agent runs exactly the same
 *   call again (`args_hash`): that relay finds it, consumes it, and the call runs
 *   without asking (`takeApprovedCall`).
 */

import { sessionPendingPermissions } from '@kortix/db';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export type PermissionDecision = 'once' | 'always' | 'reject';

export interface PendingPermission {
  id: string;
  accountId: string;
  projectId: string;
  sessionId: string;
  surfaceSessionId: string | null;
  requestId: string;
  tool: string;
  permission: string;
  patterns: string[];
  args: unknown;
  argsHash: string;
  askedAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  decision: string | null;
}

const columns = {
  id: sessionPendingPermissions.id,
  accountId: sessionPendingPermissions.accountId,
  projectId: sessionPendingPermissions.projectId,
  sessionId: sessionPendingPermissions.sessionId,
  surfaceSessionId: sessionPendingPermissions.surfaceSessionId,
  requestId: sessionPendingPermissions.requestId,
  tool: sessionPendingPermissions.tool,
  permission: sessionPendingPermissions.permission,
  patterns: sessionPendingPermissions.patterns,
  args: sessionPendingPermissions.args,
  argsHash: sessionPendingPermissions.argsHash,
  askedAt: sessionPendingPermissions.askedAt,
  expiresAt: sessionPendingPermissions.expiresAt,
  decidedAt: sessionPendingPermissions.decidedAt,
  decision: sessionPendingPermissions.decision,
};

function shaped(row: Omit<PendingPermission, 'patterns'> & { patterns: unknown }): PendingPermission {
  return { ...row, patterns: Array.isArray(row.patterns) ? (row.patterns as string[]) : [] };
}

/**
 * Store an ask. Idempotent on (session, request id): a relay retry updates
 * nothing a person may already have decided. `inserted` is true only for the
 * first record of a request id.
 */
export async function recordPendingPermission(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  surfaceSessionId: string;
  requestId: string;
  runtimeSessionId: string | null;
  tool: string;
  permission: string;
  patterns: string[];
  args: unknown;
  argsHash: string;
  expiresAt: string;
}): Promise<{ id: string; inserted: boolean } | null> {
  const [row] = await db
    .insert(sessionPendingPermissions)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      surfaceSessionId: input.surfaceSessionId,
      requestId: input.requestId,
      runtimeSessionId: input.runtimeSessionId,
      tool: input.tool,
      permission: input.permission,
      patterns: input.patterns as never,
      args: (input.args ?? null) as never,
      argsHash: input.argsHash,
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: [sessionPendingPermissions.sessionId, sessionPendingPermissions.requestId],
      set: { updatedAt: new Date().toISOString() },
    })
    .returning({ id: sessionPendingPermissions.id, inserted: sql<boolean>`(xmax = 0)` });
  return row ? { id: row.id, inserted: row.inserted === true } : null;
}

/**
 * Consume an approval a person gave while this exact call (`argsHash`) was
 * parked, for the agent's re-run. Atomic: two re-runs cannot both use one
 * `once`. Null: nothing approved this call.
 */
export async function takeApprovedCall(sessionId: string, argsHash: string): Promise<{ decision: 'once' | 'always'; permission: string } | null> {
  const [row] = await db.execute<{ decision: 'once' | 'always'; permission: string }>(sql`
    UPDATE kortix.session_pending_permissions
       SET consumed_at = NOW(), updated_at = NOW()
     WHERE id = (
       SELECT id FROM kortix.session_pending_permissions
        WHERE session_id = ${sessionId}
          AND args_hash = ${argsHash}
          AND consumed_at IS NULL
          AND decision IN ('once', 'always')
        ORDER BY decided_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING decision, permission
  `);
  return row ?? null;
}

export async function getPendingPermission(projectId: string, id: string): Promise<PendingPermission | null> {
  const [row] = await db
    .select(columns)
    .from(sessionPendingPermissions)
    .where(and(eq(sessionPendingPermissions.id, id), eq(sessionPendingPermissions.projectId, projectId)))
    .limit(1);
  return row ? shaped(row) : null;
}

/**
 * Decide an open ask: compare-and-set on `decided_at`, so two people deciding
 * at once produce one decision. `consumed` marks a decision the live call took
 * at once. False: it was already decided (or expired).
 */
export async function decidePendingPermission(input: {
  id: string;
  decision: PermissionDecision | 'expired' | 'withdrawn';
  decidedBy: string | null;
  consumed?: boolean;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await db
    .update(sessionPendingPermissions)
    .set({
      decidedAt: now,
      decision: input.decision,
      decidedBy: input.decidedBy,
      updatedAt: now,
      ...(input.consumed ? { consumedAt: now } : {}),
    })
    .where(
      and(
        eq(sessionPendingPermissions.id, input.id),
        isNull(sessionPendingPermissions.decidedAt),
        or(isNull(sessionPendingPermissions.expiresAt), gt(sessionPendingPermissions.expiresAt, sql`NOW()`)),
      ),
    )
    .returning({ id: sessionPendingPermissions.id });
  return rows.length > 0;
}

/** The live call took this decision: mark it consumed so a re-run asks again. */
export async function markPermissionConsumed(id: string): Promise<void> {
  await db
    .update(sessionPendingPermissions)
    .set({ consumedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(sessionPendingPermissions.id, id));
}

/**
 * A client replied to the request through the session proxy (the live card):
 * the runtime ran or refused the call in the same turn. Records who decided.
 */
export async function closeRepliedPermission(input: {
  sessionId: string;
  requestId: string;
  reply: PermissionDecision;
  decidedBy: string | null;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await db
    .update(sessionPendingPermissions)
    .set({ decidedAt: now, decision: input.reply, decidedBy: input.decidedBy, consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(sessionPendingPermissions.sessionId, input.sessionId),
        eq(sessionPendingPermissions.requestId, input.requestId),
        isNull(sessionPendingPermissions.decidedAt),
      ),
    )
    .returning({ id: sessionPendingPermissions.id });
  return rows.length > 0;
}

/** Open asks of these sessions (Needs you counts). */
export async function countOpenPermissionsBySession(sessionIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (sessionIds.length === 0) return counts;
  const rows = await db
    .select({ sessionId: sessionPendingPermissions.sessionId, n: sql<number>`count(*)::int` })
    .from(sessionPendingPermissions)
    .where(
      and(
        inArray(sessionPendingPermissions.sessionId, [...sessionIds]),
        isNull(sessionPendingPermissions.decidedAt),
        or(isNull(sessionPendingPermissions.expiresAt), gt(sessionPendingPermissions.expiresAt, sql`NOW()`)),
      ),
    )
    .groupBy(sessionPendingPermissions.sessionId);
  for (const row of rows) counts.set(row.sessionId, Number(row.n));
  return counts;
}

/** The newest open ask of a session, for the session's own card. */
export async function getOpenPermission(sessionId: string): Promise<PendingPermission | null> {
  const [row] = await db
    .select(columns)
    .from(sessionPendingPermissions)
    .where(
      and(
        eq(sessionPendingPermissions.sessionId, sessionId),
        isNull(sessionPendingPermissions.decidedAt),
        or(isNull(sessionPendingPermissions.expiresAt), gt(sessionPendingPermissions.expiresAt, sql`NOW()`)),
      ),
    )
    .orderBy(desc(sessionPendingPermissions.askedAt))
    .limit(1);
  return row ? shaped(row) : null;
}

/** The message that tells the agent a person decided a call that parked. */
export function renderPermissionDecisionPrompt(ask: Pick<PendingPermission, 'tool' | 'patterns'>, decision: PermissionDecision): string {
  const subject = ask.patterns[0] && ask.patterns[0] !== '*' ? ask.patterns[0] : '';
  const call = subject ? `the ${ask.tool} call \`${subject}\`` : `the ${ask.tool} call`;
  if (decision === 'reject') {
    return `The person denied ${call} you asked to run earlier. Do not run it. Continue another way, or end your turn and say what you cannot do without it.`;
  }
  const scope = decision === 'always' ? ` They also allowed every ${ask.tool} call for the rest of this session.` : '';
  return `The person approved ${call} you asked to run earlier.${scope} Run exactly the same call again now; it runs without asking. Then continue the work it was for.`;
}
