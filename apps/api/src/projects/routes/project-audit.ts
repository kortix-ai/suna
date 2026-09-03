/**
 * Audit surfaces: the project-wide log, the authenticated sandbox ingestion
 * endpoint, and the per-session reconstruction timeline.
 */

import { PROJECT_ACTIONS } from '../../iam';
import { approvalPageUrl } from '../../setup-links/token';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { auditDb, isAuditContentionError } from '../../shared/audit-db';
import { createRoute, z } from '@hono/zod-openapi';
import { auditEvents, connectors, connectorCalls, projectSessions, sessionEnvironments, sessionSandboxes, serviceAccounts } from '@kortix/db';
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { loadProjectForUser, loadVisibleSession, lookupEmailsByUserIds, assertProjectCapability } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { UUID_V4_REGEX } from '../lib/serializers';
import { requireEntitlement } from '../../accounts/iam/helpers';
import { accountHasEntitlement } from '../../billing/services/entitlements';
import { buildFilters } from '../../accounts/audit-filters';
import {
  buildAuditCursorCondition,
  parseAuditCursor,
  parseAuditInstant,
  parseAuditLimit,
  parseAuditSessionCursor,
  serializeAuditEvent,
} from '../../shared/audit-query';
import { flushAuditEvents } from '../../shared/audit';
import { AuditEventSchema, AuditListSchema } from '../../shared/audit-schema';
import { parseOpenCodeAuditBatch } from '../../shared/opencode-audit-ingestion';
import { applyOpenCodeAuditRateLimit } from '../../shared/opencode-audit-rate-guard';
import { flagSessionAuditRateLimited } from '../lib/session-audit-rate-flag';
import { callerKortixSessionId } from '../lib/caller-session';
import { getSessionRuntimeCredential } from '../../middleware/session-sandbox-credential';

/**
 * Rows per audit-ingest INSERT statement. Each statement holds this session's
 * `audit_session_sequences` row lock until it commits, so this is the knob that
 * bounds how long one ingest can block another. Overridable for an operator who
 * needs to trade lock hold time against round trips.
 */
const AUDIT_INGEST_CHUNK = (() => {
  const raw = Number.parseInt(process.env.KORTIX_AUDIT_INGEST_CHUNK ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 25;
})();

/** Advertised backoff when the session's sequence lock is contended. */
const AUDIT_INGEST_RETRY_AFTER_SECONDS = 5;

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
        actor_type: z.enum(['human', 'agent', 'service_account', 'system']).optional(),
        session_id: z.string().optional(),
        source: z.string().optional(),
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
      conditions.push(
        buildAuditCursorCondition(cursor, loaded.row.accountId, 'descending'),
      );
    }
    // Audit writes are buffered off the request path (shared/audit-queue.ts).
    // A reader must observe every event already emitted, so drain the queue
    // before querying.
    await flushAuditEvents();
    const fetched = await db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.eventId))
      .limit(limit + 1);
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    const last = rows.at(-1);
    return c.json({
      events: rows.map(serializeAuditEvent),
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
    const runtimeCredential = getSessionRuntimeCredential(c);
    if (!runtimeCredential) {
      return c.json({ error: 'audit ingestion requires a sandbox token' }, 403);
    }
    const accountId = c.get('accountId');
    if (!accountId || runtimeCredential.sessionId !== sessionId) {
      return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }
    const selected = {
      sessionId: projectSessions.sessionId,
      opencodeSessionId: projectSessions.opencodeSessionId,
      agentName: projectSessions.agentName,
      createdBy: projectSessions.createdBy,
    };
    const [scope] =
      runtimeCredential.kind === 'environment'
        ? await db
            .select(selected)
            .from(sessionEnvironments)
            .innerJoin(
              projectSessions,
              and(
                eq(projectSessions.accountId, sessionEnvironments.accountId),
                eq(projectSessions.projectId, sessionEnvironments.projectId),
                eq(projectSessions.sessionId, sessionEnvironments.sessionId),
              ),
            )
            .where(
              and(
                eq(sessionEnvironments.environmentId, runtimeCredential.runtimeId),
                eq(sessionEnvironments.sessionId, sessionId),
                eq(sessionEnvironments.accountId, accountId),
                eq(sessionEnvironments.projectId, projectId),
                inArray(sessionEnvironments.status, ['provisioning', 'active']),
              ),
            )
            .limit(1)
        : await db
            .select(selected)
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
                eq(sessionSandboxes.sandboxId, runtimeCredential.runtimeId),
                eq(sessionSandboxes.accountId, accountId),
                eq(sessionSandboxes.projectId, projectId),
                inArray(sessionSandboxes.status, ['provisioning', 'active']),
              ),
            )
            .limit(1);
    if (!scope || scope.sessionId !== sessionId) {
      return c.json({ error: 'sandbox token is not scoped to this project and session' }, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const identityConditions = [
      and(
        eq(serviceAccounts.projectId, projectId),
        eq(serviceAccounts.agentName, scope.agentName),
      ),
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
          initiatorActorType: initiatorIdentity
            ? 'service_account'
            : scope.createdBy
              ? 'human'
              : 'system',
          initiatorActorId: scope.createdBy,
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

    // Write in bounded chunks, never one 200-row statement.
    //
    // Every row's BEFORE INSERT trigger locks this session's
    // `audit_session_sequences` row, and PostgreSQL holds that lock until the
    // statement's transaction COMMITs. One 200-row statement therefore pinned
    // the session for its entire duration (measured 137 ms on a warm 5.09M-row
    // audit_events; the Essentia box runs an order of magnitude slower), and a
    // rollback discarded all 200 rows' work, which the relay then re-sent in
    // full. Chunking bounds both: the lock is held per chunk, and chunks that
    // already committed stay committed.
    let attempted = 0;
    let insertedCount = 0;
    let contended = false;
    for (let offset = 0; offset < toInsert.length; offset += AUDIT_INGEST_CHUNK) {
      const chunk = toInsert.slice(offset, offset + AUDIT_INGEST_CHUNK);
      try {
        const inserted = await auditDb()
          .insert(auditEvents)
          .values(chunk)
          .onConflictDoNothing()
          .returning({ eventId: auditEvents.eventId });
        attempted += chunk.length;
        insertedCount += inserted.length;
      } catch (error) {
        if (!isAuditContentionError(error)) throw error;
        // The session lock is queued. Pushing the remaining chunks into it
        // would only lengthen the queue that just rejected this one. Stop and
        // tell the relay to come back — the batch is still in its spool.
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
      // that caused it (Essentia 2026-08-26: 445 x 500 [57014] in 3h).
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
    summary: 'GET /:projectId/sessions/:sessionId/audit',
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
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

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
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
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
    // per session open, forever (essentia, 2026-08-24). A count of pending
    // connector calls does not depend on the audit queue at all.
    if (audited && includeEvents) await flushAuditEvents();
    const fetchedEvents = audited && includeEvents
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

    const rows = await db
      .select({
        executionId: connectorCalls.executionId,
        connectorId: connectorCalls.connectorId,
        actionPath: connectorCalls.actionPath,
        actingUserId: connectorCalls.actingUserId,
        status: connectorCalls.status,
        risk: connectorCalls.risk,
        resultSummary: connectorCalls.resultSummary,
        approvedBy: connectorCalls.approvedBy,
        createdAt: connectorCalls.createdAt,
        resolvedAt: connectorCalls.resolvedAt,
      })
      .from(connectorCalls)
      .where(
        and(
          eq(connectorCalls.projectId, projectId),
          eq(connectorCalls.sessionId, sessionId),
          ...(audited
            ? []
            : [
                eq(connectorCalls.status, 'pending_approval'),
                isNull(connectorCalls.approvedBy),
                isNull(connectorCalls.resolvedAt),
              ]),
        ),
      )
      // Most-recent-first: when a busy session exceeds `limit`, keep the RECENT
      // actions (truncating oldest), not the other way round.
      .orderBy(desc(connectorCalls.createdAt))
      .limit(limit);

    // Resolve actor + approver emails in one batched lookup (managers see who).
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.actingUserId, r.approvedBy]).filter((v): v is string => !!v),
      ),
    ];
    const emailByUser = userIds.length
      ? await lookupEmailsByUserIds(userIds)
      : new Map<string, string>();

    // Connector slugs in one batched lookup — the UI needs `<slug>.<action>`
    // to offer a "always run this" project-policy shortcut on a pending row.
    const connectorIds = [
      ...new Set(rows.map((r) => r.connectorId).filter((v): v is string => !!v)),
    ];
    const slugByConnector = new Map<string, string>();
    if (connectorIds.length) {
      const conns = await db
        .select({ connectorId: connectors.connectorId, slug: connectors.slug })
        .from(connectors)
        .where(inArray(connectors.connectorId, connectorIds));
      for (const conn of conns) slugByConnector.set(conn.connectorId, conn.slug);
    }

    return c.json({
      session_id: sessionId,
      agent: (visible.row.agentName as string | null) ?? null,
      // False when the account lacks the Enterprise `auditAccess` entitlement:
      // `actions` then contains only unresolved pending approvals, and the UI
      // shows the upgrade path for the full trail.
      audit_access: audited,
      count: audited ? eventRows.length : rows.length,
      events: eventRows.map(serializeAuditEvent),
      next_cursor:
        hasMoreEvents && lastEvent?.sessionSequence != null
          ? `${lastEvent.sessionSequence}|${lastEvent.eventId}`
          : null,
      // Most-recent-first trail of every connector-gated action this session took.
      actions: rows.map((r) => ({
        execution_id: r.executionId,
        action: r.actionPath,
        connector_id: r.connectorId,
        connector: r.connectorId ? (slugByConnector.get(r.connectorId) ?? null) : null,
        status: r.status, // ok | error | denied | pending_approval
        risk: r.risk, // read | write | destructive | null
        acted_by: r.actingUserId,
        acted_by_email: r.actingUserId ? (emailByUser.get(r.actingUserId) ?? null) : null,
        // Who resolved a gated action — set for BOTH approve and deny (the
        // approvedBy column doubles as "resolver"). null while still pending.
        resolved_by: r.approvedBy,
        resolved_by_email: r.approvedBy ? (emailByUser.get(r.approvedBy) ?? null) : null,
        result_summary: r.resultSummary ?? null,
        at: r.createdAt.toISOString(),
        resolved_at: r.resolvedAt?.toISOString() ?? null,
        // For an UNRESOLVED row, the standalone page where a human reviews the
        // full (redacted) arguments and decides. Minted here so the in-session
        // notice can link straight to it without a second round trip. Only for
        // pending rows: a resolved row has nothing left to decide, and a
        // settled decision shouldn't carry a live link around.
        approval_url:
          r.status === 'pending_approval' && !r.resolvedAt
            ? approvalPageUrl(projectId, r.executionId, sessionId)
            : null,
      })),
    });
  },
);
