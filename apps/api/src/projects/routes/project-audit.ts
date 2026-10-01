/**
 * Audit surfaces: the project-wide log, the authenticated sandbox ingestion
 * endpoint, and the per-session reconstruction timeline.
 */

import { auditCredentialNames } from '../../shared/audit-credential-names';
import { createRoute, z } from '@hono/zod-openapi';
import {
  accountTokens,
  auditEvents,
  projectSessions,
  serviceAccounts,
  sessionSandboxes,
} from '@kortix/db';
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { buildFilters } from '../../accounts/audit-filters';
import { requireEntitlement } from '../../accounts/iam/helpers';
import { accountHasEntitlement } from '../../billing/services/entitlements';
import { PROJECT_ACTIONS } from '../../iam';
import { logger as appLogger } from '../../lib/logger';
import { requestDeadlineMs } from '../../middleware/request-deadline';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors, json } from '../../openapi';
import { agentAuditInitiator } from '../../shared/agent-audit-attribution';
import { AUDIT_READ_FLUSH_BARRIER_MS, flushAuditEvents } from '../../shared/audit';
import {
  AUDIT_STATEMENT_TIMEOUT_MS,
  auditDb,
  auditErrorSqlstate,
  isAuditContentionError,
} from '../../shared/audit-db';
import {
  buildAuditCursorCondition,
  parseAuditCursor,
  parseAuditInstant,
  parseAuditLimit,
  parseAuditSessionCursor,
  serializeAuditEvent,
} from '../../shared/audit-query';
import { AuditActorTypeSchema, AuditEventSchema, AuditListSchema } from '../../shared/audit-schema';
import { currentInboundAuditScope } from '../../shared/audit-scope';
import { isAuditSessionLockTimeout, withAuditSessionLock } from '../../shared/audit-session-serial';
import { db } from '../../shared/db';
import { MAX_BATCH_SIZE, parseOpenCodeAuditBatch } from '../../shared/opencode-audit-ingestion';
import { applyOpenCodeAuditRateLimit } from '../../shared/opencode-audit-rate-guard';
import { isUuid } from '../../shared/validate';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { sandboxTokenMayActOnSession } from '../lib/sandbox-token-session';
import { flagSessionAuditRateLimited } from '../lib/session-audit-rate-flag';
import { readSessionAuditActions } from '../lib/session-audit-read';

/**
 * The human a session acts on behalf of, for OpenCode audit ingestion. A
 * session PAT carries it (auth middleware); a legacy sandbox key does not, so
 * the session's live agent token is read. Any failure → null.
 */
async function ingestionOnBehalfOf(
  c: any,
  sessionId: string,
  accountId: string,
): Promise<string | null> {
  if (c.get('authType') === 'pat')
    return (c.get('onBehalfOfUserId') as string | null | undefined) ?? null;
  try {
    const [token] = await db
      .select({ onBehalfOfUserId: accountTokens.onBehalfOfUserId })
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.sessionId, sessionId),
          eq(accountTokens.accountId, accountId),
          eq(accountTokens.status, 'active'),
          isNull(accountTokens.revokedAt),
        ),
      )
      .limit(1);
    return token?.onBehalfOfUserId ?? null;
  } catch {
    return null;
  }
}

/**
 * Rows per audit-ingest INSERT statement. Each statement holds this session's
 * `audit_session_sequences` row lock until it commits, so this is the knob that
 * bounds how long one ingest can block another.
 *
 * The default is the route's own batch ceiling (`MAX_BATCH_SIZE`): one accepted
 * relay batch is ONE statement. Every acquisition and every round trip is a
 * place a concurrent writer for the same session can interleave, and the lock
 * is re-queued between statements — so a batch split into 25-row statements
 * cost 8 acquisitions per POST and let concurrent POSTs alternate their way
 * past the request deadline (prod 2026-09-29: hot sessions posted full
 * 200-event batches back to back and `audit/events` burned 5,155 25 s-deadline
 * 503s in 3 h while every other DB-bound route's p95 rose with it). The row
 * lock is held only for the statement's own insert work, which is the same
 * total for the batch whatever the split, so the split bought nothing but
 * interleaving. Same-process writers already serialize on the in-process
 * session mutex (`shared/audit-session-serial.ts`), which removed the
 * dropped-queue-row failure the small chunk once guarded against.
 *
 * Read per request, not at module load, so an operator can lower it
 * (`KORTIX_AUDIT_INGEST_CHUNK`) to trade round trips for shorter lock holds.
 */
export function auditIngestChunkSize(): number {
  const raw = Number.parseInt(process.env.KORTIX_AUDIT_INGEST_CHUNK ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_BATCH_SIZE;
}

/** Advertised backoff when the session's sequence lock is contended. */
const AUDIT_INGEST_RETRY_AFTER_SECONDS = 5;

/**
 * How long one chunk waits for the in-process per-session audit lock before it
 * reports contention (`shared/audit-session-serial.ts`). The holder is another
 * audit INSERT for the same session in this process — the request's own inbound
 * audit row the queue flushes, or a concurrent batch for the session. Waiting
 * in memory cannot be cut short by the pool's `lock_timeout`, so this budget
 * covers the holder's own statement budget (10 s) plus margin, while staying
 * under the 25 s request deadline.
 */
const AUDIT_INGEST_LOCK_WAIT_MS = (() => {
  const raw = Number.parseInt(process.env.KORTIX_AUDIT_INGEST_LOCK_WAIT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 12_000;
})();

/**
 * The in-process lock wait is capped per attempt so a chunk's worst case (this
 * wait, plus the audit pool's statement timeout, plus a 1s response margin)
 * always fits inside the request's remaining budget. A chunk cannot consume
 * both bounds fully — a lock wait that exhausts its cap throws before any
 * insert — but a chunk that acquires the lock late and then writes into a slow
 * statement approaches it.
 */
const AUDIT_INGEST_ATTEMPT_MARGIN_MS = 1_000;

/**
 * The smallest in-process lock wait an ingest attempt still accepts. Below it
 * the request cannot afford another statement's worst case, so it answers with
 * the controlled contended 503 instead of racing its own deadline. A busy
 * mutex throws past this cap and is classified as contention, so a small floor
 * only bounds the wasted wait; it never forces a statement past the deadline.
 */
const AUDIT_INGEST_MIN_LOCK_WAIT_MS = 250;

/**
 * Rows in the smallest statement a contended ingest falls back to (half of the
 * chunk, repeatedly, until here). 25 rows was the pre-KRTX-665 statement size
 * and is what `KORTIX_AUDIT_INGEST_CHUNK` still documents as the operator
 * setting, so a fallback statement never writes more than the smallest chunk
 * the route already promised to bound.
 */
const AUDIT_INGEST_MIN_CHUNK = 25;

/**
 * Resolve with `{ timedOut: true }` if `work` is still pending after
 * `boundMs`, else with its value.
 *
 * The ingest chunk's own bounds (the in-process lock wait, the audit pool's
 * statement timeout) bound their waits, but the wait for one of the audit
 * pool's backends has NO bound: postgres.js has no acquire-queue timeout, so
 * a statement whose two backends are busy queues for a connection for as
 * long as the convoy in front of it takes (prod 2026-09-29, hours after the
 * KRTX-644 budget check shipped: request-rate bursts kept both backends busy
 * and ingest requests still died with the uncontrolled
 * `request exceeded the 25s server processing deadline` abort mid-acquire).
 * Racing the chunk against the request's remaining budget is the one bound
 * that covers the acquire wait too.
 *
 * The loser of the race keeps running. Its eventual rejection has a handler
 * through the race itself, and the caller answers the controlled contended
 * 503 either way — the abandoned statement's rows still land
 * (`onConflictDoNothing`) and the relay's retry is absorbed as duplicates.
 */
export async function boundChunkWrite<T>(
  work: Promise<T>,
  boundMs: number,
): Promise<{ timedOut: true; value?: undefined } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), boundMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Milliseconds left before this request's server-processing deadline, or null
 * when the guard is off: the deadline is disabled/exempt, or no inbound audit
 * scope exists (unit tests drive the bare app). The edge
 * (`shared/audit-edge.ts`) stamps `startedAt` before any middleware runs, so
 * the budget covers auth and body parsing too — the time the handler did not
 * spend itself.
 */
function remainingIngestBudgetMs(c: unknown): number | null {
  const deadline = requestDeadlineMs(c as Parameters<typeof requestDeadlineMs>[0]);
  if (deadline === null) return null;
  const startedAt = currentInboundAuditScope()?.startedAt;
  if (!startedAt) return null;
  return startedAt + deadline - Date.now();
}

/** The PostgreSQL SQLSTATE behind a contention error, following `cause`. */
function auditErrorSqlState(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    const cause = (current as { cause?: unknown }).cause;
    if (cause === current) break;
    current = cause;
  }
  return null;
}

// GET /v1/projects/:projectId/audit
// Canonical project slice. It returns the same event contract and cursor as
// the account log, with project_id bound server-side to the authorized project.
// This aggregate oversight surface can include private-session metadata, so it
// requires the project-members management capability instead of session read.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/audit',
    tags: ['projects'],
    summary: 'List canonical project audit events',
    ...auth,
    request: {
      params: z.object({ projectId: z.string().uuid() }),
      query: z.object({
        action: z.string().optional(),
        actor: z.string().uuid().optional(),
        actor_type: AuditActorTypeSchema.optional(),
        session_id: z.string().optional(),
        source: z.string().optional(),
        credential_kind: z.string().optional(),
        phase: z.string().optional(),
        outcome: z.enum(['success', 'failure', 'denied', 'pending']).optional(),
        request_id: z.string().optional(),
        correlation_id: z.string().optional(),
        resource_type: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        q: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: json(AuditListSchema, 'Canonical project audit page'),
      ...errors(400, 402, 403, 404),
    },
  }),
  // biome-ignore lint/suspicious/noExplicitAny: Current OpenAPI response unions require the established untyped route-handler boundary.
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );
    const denied = await requireEntitlement(c, loaded.row.accountId, 'auditAccess');
    if (denied) return denied;

    const sinceRaw = c.req.query('since')?.trim() || null;
    const untilRaw = c.req.query('until')?.trim() || null;
    let cursor: ReturnType<typeof parseAuditCursor>;
    let limit: number;
    try {
      parseAuditInstant(sinceRaw, 'since');
      parseAuditInstant(untilRaw, 'until');
      cursor = parseAuditCursor(c.req.query('cursor')?.trim() || null);
      limit = parseAuditLimit(c.req.query('limit')?.trim() || null, 50, 200);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    const conditions = buildFilters(loaded.row.accountId, {
      actor: c.req.query('actor')?.trim() || null,
      actorType: c.req.query('actor_type')?.trim() || null,
      projectId,
      sessionId: c.req.query('session_id')?.trim() || null,
      source: c.req.query('source')?.trim() || null,
      credentialKind: c.req.query('credential_kind')?.trim() || null,
      phase: c.req.query('phase')?.trim() || null,
      outcome: c.req.query('outcome')?.trim() || null,
      requestId: c.req.query('request_id')?.trim() || null,
      correlationId: c.req.query('correlation_id')?.trim() || null,
      actionPrefix: c.req.query('action')?.trim() || null,
      resourceType: c.req.query('resource_type')?.trim() || null,
      sinceRaw,
      untilRaw,
      q: c.req.query('q')?.trim() || null,
    });
    if (cursor) {
      conditions.push(buildAuditCursorCondition(cursor, loaded.row.accountId, 'descending'));
    }
    // Audit writes are buffered off the request path (shared/audit-queue.ts).
    // A reader must observe every event already emitted, so drain the queue
    // before querying.
    await flushAuditEvents({ waitMs: AUDIT_READ_FLUSH_BARRIER_MS });
    const fetched = await db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.eventId))
      .limit(limit + 1);
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    const last = rows.at(-1);
    const names = await auditCredentialNames(rows);
    return c.json({
      events: rows.map((row) => serializeAuditEvent(row, names)),
      next_cursor: hasMore && last ? `${last.occurredAt.toISOString()}|${last.eventId}` : null,
    });
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/audit/events
// Authenticated sandbox ingestion. The credential is bound to one project and
// one session. Only redacted summaries and hashes are accepted.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/audit/events',
    tags: ['sessions'],
    summary: 'Ingest an idempotent OpenCode audit batch',
    ...auth,
    request: {
      params: z.object({ projectId: z.string().uuid(), sessionId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(AnyObject, 'Batch ingestion result'),
      // Lock contention on kortix.audit_session_sequences. Retryable: the relay
      // still holds the batch in its own durable spool.
      503: json(AnyObject, 'Audit ingestion is contended'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isSessionSandboxCredential(c)) {
      return c.json({ error: 'audit ingestion requires a sandbox token' }, 403);
    }
    const accountId = c.get('accountId');
    const sandboxId = c.get('sandboxId');
    if (!accountId || !sandboxId || !sandboxTokenMayActOnSession(sandboxId, sessionId)) {
      return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }
    const [scope] = await db
      .select({
        sessionId: sessionSandboxes.sessionId,
        opencodeSessionId: projectSessions.runtimeSessionId,
        agentName: projectSessions.agentName,
        createdBy: projectSessions.createdBy,
        origin: projectSessions.origin,
        metadata: projectSessions.metadata,
      })
      .from(sessionSandboxes)
      .innerJoin(
        projectSessions,
        and(
          eq(projectSessions.accountId, sessionSandboxes.accountId),
          eq(projectSessions.projectId, sessionSandboxes.projectId),
          eq(projectSessions.sessionId, sessionSandboxes.sessionId),
        ),
      )
      .where(
        and(
          eq(sessionSandboxes.sandboxId, sandboxId),
          eq(sessionSandboxes.accountId, accountId),
          eq(sessionSandboxes.projectId, projectId),
          inArray(sessionSandboxes.status, ['provisioning', 'active']),
        ),
      )
      .limit(1);
    if (!scope || (scope.sessionId ?? sandboxId) !== sessionId) {
      return c.json({ error: 'sandbox token is not scoped to this project and session' }, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const identityConditions = [
      and(eq(serviceAccounts.projectId, projectId), eq(serviceAccounts.agentName, scope.agentName)),
    ];
    if (scope.createdBy) {
      identityConditions.push(eq(serviceAccounts.serviceAccountId, scope.createdBy));
    }
    const identities = await db
      .select({
        serviceAccountId: serviceAccounts.serviceAccountId,
        agentName: serviceAccounts.agentName,
      })
      .from(serviceAccounts)
      .where(and(eq(serviceAccounts.accountId, accountId), or(...identityConditions)));
    const agentIdentity = identities.find((identity) => identity.agentName === scope.agentName);
    const initiatorIdentity = scope.createdBy
      ? identities.find((identity) => identity.serviceAccountId === scope.createdBy)
      : null;
    // Spec 2026-09-22 §2: the same initiator rule every other agent-session
    // audit row uses (shared/agent-audit-attribution.ts), plus the human the
    // session acts on behalf of — read from the credential when it is the
    // session token, else from the session's live agent token.
    const onBehalfOfUserId = await ingestionOnBehalfOf(c, sessionId, accountId);
    const initiator = agentAuditInitiator({
      onBehalfOfUserId,
      session: {
        origin: scope.origin ?? null,
        metadata: (scope.metadata ?? {}) as Record<string, unknown>,
        createdBy: scope.createdBy ?? null,
        createdByIsServiceAccount: Boolean(initiatorIdentity),
      },
    });

    let parsed: ReturnType<typeof parseOpenCodeAuditBatch>;
    try {
      parsed = parseOpenCodeAuditBatch(body, {
        accountId,
        projectId,
        sessionId,
        trustedProvenance: {
          opencodeSessionId: scope.opencodeSessionId,
          agentId: agentIdentity?.serviceAccountId ?? null,
          agentName: scope.agentName,
          initiatorActorType: initiator.type,
          initiatorActorId: initiator.id,
          onBehalfOfUserId,
          correlationId: sessionId,
          causationId: null,
          delegationDepth: 0,
        },
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    // Per-session ingest ceiling. A single runaway turn emitting ~1725
    // `opencode.message.part.delta` rows/min took staging down through
    // audit_events index contention (release-gate run 32151213430); this bounds
    // the write rate before it reaches a 14-index table. It drops ONLY the
    // per-token delta class and never blocks the request.
    //
    // Wrapped because a guard defect must never cost an audit write: any throw
    // here falls back to persisting the batch exactly as parsed.
    let toInsert = parsed.values;
    let suppressed = 0;
    try {
      const decision = applyOpenCodeAuditRateLimit({
        accountId,
        projectId,
        sessionId,
        values: parsed.values,
      });
      toInsert = decision.values;
      suppressed = decision.suppressed;
      if (decision.flagForReaper) {
        // Durable, best-effort marker for the maintenance sweep and for
        // operators querying during an incident. Deliberately not awaited: the
        // hot path must not gain a write it has to wait on.
        void flagSessionAuditRateLimited({
          accountId,
          projectId,
          sessionId,
          consecutiveHotWindows: decision.consecutiveHotWindows,
        });
      }
    } catch {
      toInsert = parsed.values;
      suppressed = 0;
    }

    if (toInsert.length === 0) {
      return c.json({ accepted: parsed.accepted, inserted: 0, duplicates: 0, suppressed });
    }

    // Write the batch in bounded statements. The first attempt carries
    // `auditIngestChunkSize()` rows — one statement per accepted batch by
    // default. Each statement's rows lock this session's
    // `audit_session_sequences` row until its COMMIT: the lock holds only the
    // statement's own insert work, a rejected statement rolls back only its
    // own rows, and the relay re-sends what did not land after its backoff.
    let attempted = 0;
    let insertedCount = 0;
    let contended = false;
    let chunkSize = auditIngestChunkSize();
    let fallbacks = 0;
    for (let offset = 0; offset < toInsert.length; ) {
      // Stay inside the request's own 25s deadline. A chunk must not start
      // unless its worst case (in-process lock wait + the audit pool's
      // statement timeout + margin) fits the remaining budget; the deadline
      // middleware otherwise aborts mid-batch with an error-level
      // `request exceeded the 25s server processing deadline` line, no
      // `Retry-After: 5` pacing, and chunks that keep writing for a response
      // nobody reads (prod 2026-09-28: the aborts were this route's dominant
      // error class). Stop at that boundary and answer with the same
      // controlled contended 503 the lock path returns — the relay holds the
      // batch in its spool and retries with `Retry-After`, and committed
      // chunks stay committed.
      const remainingMs = remainingIngestBudgetMs(c);
      // An attempt's worst case is its in-process lock wait plus the audit
      // pool's statement timeout plus a 1s response margin. The wait is CAPPED
      // to what the remaining budget affords, so a chunk never starts unless
      // it can also finish inside the request deadline — and a request with
      // less than a full 23s chunk left can still afford a smaller statement.
      const lockWaitMs =
        remainingMs === null
          ? AUDIT_INGEST_LOCK_WAIT_MS
          : Math.min(
              AUDIT_INGEST_LOCK_WAIT_MS,
              remainingMs - AUDIT_STATEMENT_TIMEOUT_MS - AUDIT_INGEST_ATTEMPT_MARGIN_MS,
            );
      if (remainingMs !== null && lockWaitMs < AUDIT_INGEST_MIN_LOCK_WAIT_MS) {
        appLogger.warn('[audit] ingest budget exhausted', {
          projectId,
          sessionId,
          remaining_ms: remainingMs,
          accepted: parsed.accepted,
          attempted,
          inserted: insertedCount,
          remaining: toInsert.length - offset,
          chunk: chunkSize,
        });
        contended = true;
        break;
      }
      const chunk = toInsert.slice(offset, offset + chunkSize);
      try {
        // Hold the process-local session lock for the chunk's INSERT. The
        // request's OWN inbound audit row is enqueued for this same session and
        // would otherwise race this insert for the same
        // `audit_session_sequences` row lock — the second writer lost at the
        // pool's 2.5 s `lock_timeout` (55P03) and the queue dropped the row.
        const chunkWork = withAuditSessionLock(
          sessionId,
          () =>
            auditDb()
              .insert(auditEvents)
              .values(chunk)
              .onConflictDoNothing()
              .returning({ eventId: auditEvents.eventId }),
          { timeoutMs: lockWaitMs },
        );
        // The chunk's own bounds (lock wait, statement timeout) do not bound
        // the wait for an audit-pool backend. Race the chunk against what is
        // left of the request deadline so a saturated pool degrades into the
        // controlled contended 503 instead of the deadline abort. When the
        // guard is off (`remainingMs === null`) there is nothing to race.
        const chunkResult =
          remainingMs === null
            ? { timedOut: false as const, value: await chunkWork }
            // 1s held back so the contended 503 response itself still fits
            // inside the deadline.
            : await boundChunkWrite(chunkWork, remainingMs - 1_000);
        if (chunkResult.timedOut) {
          // The statement keeps running off the request path. Swallow its
          // eventual rejection (a statement timeout, or the lock wait it is
          // still queued inside) so it can never surface unhandled.
          void chunkWork.catch(() => {});
          appLogger.warn('[audit] ingest budget exhausted', {
            projectId,
            sessionId,
            remaining_ms: remainingIngestBudgetMs(c),
            chunk_budget_ms: remainingMs === null ? null : remainingMs - 1_000,
            accepted: parsed.accepted,
            attempted,
            inserted: insertedCount,
            remaining: toInsert.length - offset - chunk.length,
            chunk: chunk.length,
            raced_out: true,
          });
          contended = true;
          break;
        }
        const inserted = chunkResult.value;
        attempted += chunk.length;
        insertedCount += inserted.length;
        offset += chunk.length;
      } catch (error) {
        if (!isAuditContentionError(error) && !isAuditSessionLockTimeout(error)) {
          // A write that is NOT backpressure is a defect, and until now the
          // only trace of it was Drizzle's wrapper: `DrizzleQueryError: Failed
          // query: insert into "kortix"."audit_events" …` with the whole
          // statement and every bound parameter, and no SQLSTATE anywhere —
          // the pg cause hangs off `error.cause`, which the wrapper does not
          // print. PROD 2026-09-09 06:32–06:33 UTC produced 76 of these in 90
          // seconds, alongside api_keys and account_tokens SELECT failures from
          // the same window, and the class of fault was unreadable from the
          // logs. Name the SQLSTATE and the session; the throw is unchanged.
          console.error('[audit-ingest] write failed', {
            projectId,
            sessionId,
            accountId,
            chunkSize: chunk.length,
            batchSize: toInsert.length,
            offset,
            sqlstate: auditErrorSqlstate(error),
            reason: error instanceof Error ? error.message.split('\n')[0] : String(error),
          });
          throw error;
        }
        // A contended statement committed nothing, and handing the WHOLE
        // remaining batch back to the relay makes the relay re-post every row
        // (prod 2026-09-29, KRTX-470: 6,115 57014 statement timeouts in 3 h —
        // each one a full 200-row statement that ran out of the audit pool's
        // statement_timeout, rolled back all its work, and came back as another
        // full-batch POST; the route's p95 and every other DB-bound route's
        // rose with it). Retry the SAME rows in a smaller statement first: a
        // statement that fits its budget lands rows instead of burning the
        // audit pool's two backends on work that rolls back. The budget check
        // at the top of the loop caps every further attempt the same way, so
        // the request still answers inside its deadline; past the floor, give
        // up as before.
        // Halve the rows this statement actually carried, not the chunk
        // ceiling. A 3-row batch under a 200-row ceiling used to re-send the
        // same 3 rows at "100" and "50" — byte-identical statements that each
        // held an audit-pool backend for the full statement timeout (prod
        // 2026-10-01: ~20 s per 503, two of the pool's backends' worth of
        // time, for rows no smaller statement could change).
        if (chunk.length > AUDIT_INGEST_MIN_CHUNK) {
          chunkSize = Math.max(AUDIT_INGEST_MIN_CHUNK, Math.floor(chunk.length / 2));
          fallbacks += 1;
          continue;
        }
        // The chunk is at the floor. Pushing the remaining rows into the same
        // lock queue would only lengthen it. Stop and tell the relay to come
        // back — the batch is still in its spool, and every row that landed
        // stays committed.
        //
        // Say WHICH SQLSTATE and how far the batch got. A 503 that logs only
        // `-> 503 [HTTPException]` hid a 7-day convoy (prod, from 2026-08-31
        // 19:52 UTC: ~32 sessions × one retry per ~8 s, >74,000 503s per
        // session) behind an opaque status code.
        appLogger.warn('[audit] ingest contended', {
          projectId,
          sessionId,
          // `57xxx`/`55P03` came back from Postgres; a null SQLSTATE on a
          // bounded in-process wait means the writer never reached the DB.
          sqlstate: auditErrorSqlstate(error),
          contention_source: isAuditSessionLockTimeout(error) ? 'in_process' : 'postgres',
          accepted: parsed.accepted,
          attempted,
          inserted: insertedCount,
          remaining: toInsert.length - offset,
          chunk: chunk.length,
          fallback_statements: fallbacks,
        });
        contended = true;
        break;
      }
    }
    const result = {
      accepted: parsed.accepted,
      inserted: insertedCount,
      // Rows the unique index rejected. Identical to the previous
      // `accepted - inserted` whenever nothing was suppressed.
      duplicates: Math.max(0, attempted - insertedCount),
      suppressed,
    };
    if (contended) {
      // 503, never 500. A 500 told the relay "your batch is broken" for what is
      // in fact backpressure, and its flat 1s retry then rebuilt the convoy
      // that caused it (SampleCo 2026-08-26: 445 x 500 [57014] in 3h).
      c.header('Retry-After', String(AUDIT_INGEST_RETRY_AFTER_SECONDS));
      return c.json(
        {
          ...result,
          error: 'audit ingestion is contended; retry after the backoff',
          retry_after_seconds: AUDIT_INGEST_RETRY_AFTER_SECONDS,
        },
        503,
      );
    }
    return c.json(result);
  },
);

// GET /v1/projects/:projectId/sessions/:sessionId/audit
// Per-session audit log. `events` is the canonical ordered reconstruction
// timeline. `actions` preserves the governed connector approval projection.
// Same visibility gate as the session detail/transcript (project read + the
// session must be visible to the caller). Non-Enterprise accounts get only the
// unresolved pending approvals (never a 402 — see the entitlement note below).

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/audit',
    tags: ['sessions'],
    summary: 'List audit events of a session',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      query: z.object({
        limit: z.string().optional(),
        cursor: z.string().optional(),
        include_events: z.enum(['true', 'false']).optional(),
      }),
    },
    responses: {
      200: json(
        z.object({
          session_id: z.string(),
          agent: z.string().nullable(),
          audit_access: z.boolean(),
          count: z.number().int(),
          events: z.array(AuditEventSchema),
          next_cursor: z.string().nullable(),
          actions: z.array(z.record(z.unknown())),
        }),
        'Canonical per-session reconstruction log and connector approval projection',
      ),
      ...errors(400, 404),
    },
  }),
  // biome-ignore lint/suspicious/noExplicitAny: Current OpenAPI response unions require the established untyped route-handler boundary.
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    let limit: number;
    let cursor: ReturnType<typeof parseAuditSessionCursor>;
    try {
      limit = parseAuditLimit(c.req.query('limit')?.trim() || null, 200, 1000);
      cursor = parseAuditSessionCursor(c.req.query('cursor')?.trim() || null);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(
      loaded,
      sessionId,
      callerKortixSessionId(c),
      callerKortixSessionId(c),
    );
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // The historical trail is Enterprise (`auditAccess`), but this endpoint is
    // also the approval CONTROL PLANE: write/destructive connector actions
    // default to require_approval on every tier (connector/policy.ts), the web
    // app polls this route from every open session to render the approval
    // prompt, and it is the launcher's only view of what's blocking the run.
    // A 402 here breaks approvals for every non-Enterprise account (and toasts
    // the upsell on each poll) — so unentitled accounts degrade to unresolved
    // pending approvals only instead of being denied.
    const audited = await accountHasEntitlement(loaded.row.accountId, 'auditAccess');
    const includeEvents = c.req.query('include_events') !== 'false';

    // `session_id` is the integrity-chain scope and is globally unique. The
    // visibility gate above already proves that the caller may read this
    // project session. Some request-level events are written before account
    // resolution (`auth.login.success`) or from a project-neutral endpoint
    // (`GET /v1/skills`). Those rows still belong to this session's chain. An
    // account/project predicate would remove the middle row while returning its
    // successor, which makes a valid persisted chain impossible to verify.
    const eventConditions = [eq(auditEvents.sessionId, sessionId)];
    if (cursor) {
      const cursorCondition = or(
        gt(auditEvents.sessionSequence, cursor.sequence),
        and(
          eq(auditEvents.sessionSequence, cursor.sequence),
          gt(auditEvents.eventId, cursor.eventId),
        ),
      );
      if (cursorCondition) eventConditions.push(cursorCondition);
    }
    // Audit writes are buffered off the request path (shared/audit-queue.ts).
    // A reader of EVENTS must observe every event already emitted, so drain
    // the queue before querying them.
    //
    // Only then. `include_events=false` is the badge poll — every open session
    // tab asks every 15 s for the pending-approval COUNT and never reads an
    // event row — and draining the queue on its behalf meant every one of
    // those polls waited on a bulk INSERT into `audit_events`. On a self-host
    // with 3.9 M rows that insert hit the statement timeout (57014), the
    // request hit the 25 s server deadline, and the badge answered 503 twice
    // per session open, forever (sampleco, 2026-08-24). A count of pending
    // connector calls does not depend on the audit queue at all.
    if (audited && includeEvents) await flushAuditEvents({ waitMs: AUDIT_READ_FLUSH_BARRIER_MS });
    const fetchedEvents =
      audited && includeEvents
        ? await db
            .select()
            .from(auditEvents)
            .where(and(...eventConditions))
            .orderBy(asc(auditEvents.sessionSequence), asc(auditEvents.eventId))
            .limit(limit + 1)
        : [];
    const hasMoreEvents = fetchedEvents.length > limit;
    const eventRows = hasMoreEvents ? fetchedEvents.slice(0, limit) : fetchedEvents;
    const lastEvent = eventRows.at(-1);

    // Same query, same batched email + connector-slug lookups, same
    // `approval_url` rule as before — now shared with the session-open
    // bundle's `audit` leg (`../lib/session-audit-read.ts`) so the two can
    // never disagree about what is pending.
    const names = await auditCredentialNames(eventRows);
    const auditActions = await readSessionAuditActions({
      projectId,
      sessionId,
      agentName: (visible.row.agentName as string | null) ?? null,
      audited,
      limit,
    });

    return c.json({
      session_id: sessionId,
      agent: auditActions.agent,
      // False when the account lacks the Enterprise `auditAccess` entitlement:
      // `actions` then contains only unresolved pending approvals, and the UI
      // shows the upgrade path for the full trail.
      audit_access: audited,
      // Unchanged from before the extraction: the EVENTS page size for an
      // entitled caller (0 whenever `include_events=false`, which is every
      // poll), the PENDING-ACTIONS count otherwise.
      count: audited ? eventRows.length : auditActions.count,
      events: eventRows.map((row) => serializeAuditEvent(row, names)),
      next_cursor:
        hasMoreEvents && lastEvent?.sessionSequence != null
          ? `${lastEvent.sessionSequence}|${lastEvent.eventId}`
          : null,
      // Most-recent-first trail of every connector-gated action this session took.
      actions: auditActions.actions,
    });
  },
);
