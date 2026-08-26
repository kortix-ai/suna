/**
 * The approval inbox: connector actions a policy gated as `require_approval`,
 * the per-session "needs input" summary, and the resolve endpoint.
 */

import { approvalPreviewReviewable } from '../../connectors/args-preview';
import { approvalResolvedAuditEvent } from '../../connectors/call-audit';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { inferAuditSource, recordAuditEvent } from '../../shared/audit';
import { createRoute, z } from '@hono/zod-openapi';
import { connectorCalls, projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { mayResolveApproval, maySeeSessionApprovals } from '../lib/approval-authority';
import { loadProjectForUser, lookupEmailsByUserIds, assertProjectCapability, isUuid } from '../lib/access';
import { AnyObject, OkSchema, projectsApp } from '../lib/app';
import { normalizeString, readBody,
  parseBoundedPositiveInt,
} from '../lib/serializers';
import { buildContinueSessionCommandValues, drainSessionLifecycleQueue } from '../session-lifecycle';
import { callerKortixSessionId } from '../lib/caller-session';

// GET /v1/projects/:projectId/approvals
// The approval inbox: connector actions a policy gated as `require_approval` that
// are still awaiting a human decision (status=pending_approval, unresolved).
// Manager-scoped — this is the project-wide oversight surface. A session's own
// launcher also sees + resolves the pending items for their session via the
// per-session audit view + the POST below.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/approvals',
    tags: ['access'],
    summary: 'GET /:projectId/approvals',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ limit: z.string().optional() }),
    },
    responses: {
      200: json(AnyObject, 'Pending approval inbox'),
      ...errors(400, 404),
    },
  }),
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

    const limit = parseBoundedPositiveInt(c.req.query('limit'), 100, 1, 500, 'limit');
    if (!limit.ok) return c.json({ error: limit.error }, 400);

    const rows = await db
      .select({
        executionId: connectorCalls.executionId,
        actionPath: connectorCalls.actionPath,
        risk: connectorCalls.risk,
        sessionId: connectorCalls.sessionId,
        actingUserId: connectorCalls.actingUserId,
        resultSummary: connectorCalls.resultSummary,
        createdAt: connectorCalls.createdAt,
      })
      .from(connectorCalls)
      .where(
        and(
          eq(connectorCalls.projectId, projectId),
          eq(connectorCalls.status, 'pending_approval'),
          isNull(connectorCalls.approvedBy),
          isNull(connectorCalls.resolvedAt),
        ),
      )
      .orderBy(desc(connectorCalls.createdAt))
      .limit(limit.value);

    const userIds = [...new Set(rows.map((r) => r.actingUserId).filter((v): v is string => !!v))];
    const emailByUser = userIds.length
      ? await lookupEmailsByUserIds(userIds)
      : new Map<string, string>();

    return c.json({
      count: rows.length,
      approvals: rows.map((r) => ({
        execution_id: r.executionId,
        action: r.actionPath,
        risk: r.risk,
        session_id: r.sessionId,
        requested_by: r.actingUserId,
        requested_by_email: r.actingUserId ? (emailByUser.get(r.actingUserId) ?? null) : null,
        requested_at: r.createdAt.toISOString(),
        detail: r.resultSummary ?? null,
      })),
    });
  },
);

// GET /v1/projects/:projectId/approvals/needs-input
// Lightweight per-session summary for the sidebar "needs input" indicator: which
// sessions have a connector call awaiting a human decision, and how many. A
// project MANAGER sees every session; everyone else sees only the sessions they
// LAUNCHED (mirrors who may resolve). Read-gated + cheap enough to poll.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/approvals/needs-input',
    tags: ['access'],
    summary: 'GET /:projectId/approvals/needs-input',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(AnyObject, 'Sessions awaiting a human decision'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    // Managers see every session's pending items; others only their own launched
    // sessions (same principal set the resolve endpoint accepts).
    let isManager = false;
    try {
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
      );
      isManager = true;
    } catch {
      isManager = false;
    }

    // Every unresolved pending action in the project, by session. (No DB join:
    // connector_calls.session_id is `uuid` while project_sessions.session_id
    // is `text` — cross-type equality errors in Postgres, so we resolve in JS
    // where both surface as strings.)
    const pendingRows = await db
      .select({ sessionId: connectorCalls.sessionId })
      .from(connectorCalls)
      .where(
        and(
          eq(connectorCalls.projectId, projectId),
          eq(connectorCalls.status, 'pending_approval'),
          isNull(connectorCalls.approvedBy),
          isNull(connectorCalls.resolvedAt),
        ),
      );

    // Count per (Kortix) session id.
    const byKortix: Record<string, number> = {};
    for (const r of pendingRows) {
      const sid = r.sessionId ? String(r.sessionId) : null;
      if (sid) byKortix[sid] = (byKortix[sid] ?? 0) + 1;
    }
    const kortixIds = Object.keys(byKortix);
    if (kortixIds.length === 0) return c.json({ total: 0, sessions: {} });

    // Look these sessions up to (a) gate non-managers to their own and (b) map to
    // the OpenCode session id the sidebar list keys on. The response carries BOTH
    // id forms → the caller matches whichever it holds.
    const sess = await db
      .select({
        sessionId: projectSessions.sessionId,
        opencodeSessionId: projectSessions.opencodeSessionId,
        createdBy: projectSessions.createdBy,
        origin: projectSessions.origin,
      })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, projectId),
          inArray(projectSessions.sessionId, kortixIds),
        ),
      );

    const sessions: Record<string, number> = {};
    let total = 0;
    for (const s of sess) {
      // created_by is shared across every KaaB session, so it cannot filter
      // one end-user's pending gates from another's — and an execution_id is
      // all the resolve route needs.
      if (
        !maySeeSessionApprovals({
          isManager,
          targetSessionId: s.sessionId,
          targetSessionOrigin: s.origin ?? null,
          targetSessionCreatedBy: s.createdBy,
          callerUserId: loaded.userId,
          callerSessionId: callerKortixSessionId(c),
        })
      ) {
        continue;
      }
      const n = byKortix[s.sessionId] ?? 0;
      if (n <= 0) continue;
      sessions[s.sessionId] = n;
      if (s.opencodeSessionId) sessions[s.opencodeSessionId] = n;
      total += n;
    }
    return c.json({ total, sessions });
  },
);

// POST /v1/projects/:projectId/approvals/:executionId
// Resolve a pending approval — { decision: 'approve' | 'deny' }. Allowed for a
// project MANAGER or the LAUNCHER of the session the action belongs to (the two
// principals a human-in-the-loop approval should recognise). Records who decided
// + when; idempotent-safe (a non-pending row 409s).

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/approvals/{executionId}',
    tags: ['access'],
    summary: 'POST /:projectId/approvals/:executionId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), executionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(OkSchema, 'Resolved'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const executionId = c.req.param('executionId');
    if (!isUuid(executionId)) return c.json({ error: 'Invalid execution id' }, 400);
    const body = await readBody(c);
    const decision = normalizeString(body.decision);
    if (decision !== 'approve' && decision !== 'deny') {
      return c.json({ error: "decision must be 'approve' or 'deny'" }, 400);
    }
    // NO SCOPES. A decision applies to exactly the call that asked for it.
    //
    // This used to accept 'session' ("stop asking for this tool") and
    // 'session_all' ("stop asking for anything"), surfaced as one-click buttons.
    // Both defeated the gate they were attached to: the reflex click that clears
    // today's prompt also silently pre-authorises every later call, including
    // ones with completely different arguments — a mail send to a different
    // recipient never asks again. An approval that can be waived in one click is
    // not a control. A legitimately unattended tool belongs in an explicit
    // `always_run` policy rule, authored deliberately in the Policies panel,
    // where the full rule set is visible.
    //
    // A stale client may still POST `scope` — it is ignored, not honoured.

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const [row] = await db
      .select({
        executionId: connectorCalls.executionId,
        sessionId: connectorCalls.sessionId,
        actingUserId: connectorCalls.actingUserId,
        connectorId: connectorCalls.connectorId,
        actionPath: connectorCalls.actionPath,
        status: connectorCalls.status,
        approvedBy: connectorCalls.approvedBy,
        resolvedAt: connectorCalls.resolvedAt,
        resultSummary: connectorCalls.resultSummary,
      })
      .from(connectorCalls)
      .where(
        and(eq(connectorCalls.executionId, executionId), eq(connectorCalls.projectId, projectId)),
      )
      .limit(1);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (row.status !== 'pending_approval' || row.approvedBy || row.resolvedAt) {
      return c.json({ error: 'Approval already resolved' }, 409);
    }

    // Who may resolve: a project MANAGER (the same project.members.manage IAM
    // gate the inbox uses — capability-consistent, so a custom role holding the
    // leaf without the "manager" label still qualifies), OR the human who
    // launched the session the gated action belongs to. (Founder decision:
    // managers + launcher.) assertProjectCapability throws on denial, so probe
    // it — a non-manager launcher must still fall through.
    let isManager = false;
    try {
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
      );
      isManager = true;
    } catch {
      isManager = false;
    }
    let targetCreatedBy: string | null = row.sessionId ? null : row.actingUserId;
    let targetOrigin: string | null = row.sessionId ? null : 'user';
    if (row.sessionId) {
      const [session] = await db
        .select({ createdBy: projectSessions.createdBy, origin: projectSessions.origin })
        .from(projectSessions)
        // Scope to THIS project too — sessionId is a PK so it's globally unique,
        // but making the project bound explicit keeps the gate self-documenting.
        .where(
          and(
            eq(projectSessions.sessionId, row.sessionId),
            eq(projectSessions.projectId, projectId),
          ),
        )
        .limit(1);
      targetCreatedBy = session?.createdBy ?? null;
      targetOrigin = session?.origin ?? null;
    }
    const verdict = mayResolveApproval({
      isManager,
      targetSessionOrigin: targetOrigin,
      targetSessionCreatedBy: targetCreatedBy,
      callerUserId: loaded.userId,
      callerAuthType: (c.get('authType') as string | undefined) ?? null,
      callerSessionId: callerKortixSessionId(c),
    });
    if (!verdict.allowed) {
      return c.json(
        verdict.reason === 'session_bound_caller'
          ? {
              error: 'An agent cannot resolve its own approval — a human must approve or deny this',
              code: 'APPROVAL_REQUIRES_HUMAN',
            }
          : verdict.reason === 'non_human_caller'
            ? {
                error: 'Sign in with a Kortix account to resolve this approval',
                code: 'APPROVAL_REQUIRES_HUMAN',
              }
            : { error: 'Only a project manager or the session launcher can resolve this' },
        403,
      );
    }

    const existingDetail =
      typeof row.resultSummary === 'object' && row.resultSummary ? row.resultSummary : {};
    // Blind approval stays impossible — but only when the row genuinely shows
    // NOTHING. This used to test `args_preview_complete`, which the preview
    // builder turns off for any elision at all (a long URL, an 11th recipient,
    // an attachment body), so a fully legible call could be denied and never
    // approved. See `approvalPreviewReviewable`.
    if (decision === 'approve' && !approvalPreviewReviewable(existingDetail)) {
      return c.json(
        {
          error: 'This call recorded no parameters to review, so it cannot be approved',
          code: 'APPROVAL_PREVIEW_UNAVAILABLE',
        },
        409,
      );
    }

    const detail = {
      ...existingDetail,
      decision,
      decided_by: loaded.userId,
    };
    // Atomic resolve — guard the UPDATE on the still-pending state so two
    // concurrent resolvers can't both win (TOCTOU): approve clears the gate to
    // the terminal `ok` (the real retried call re-audits as its own row), deny
    // flips it to `denied`. Both stamp approvedBy (= who resolved) + resolvedAt,
    // so the row leaves the pending inbox. A lost race matches 0 rows → 409.
    const resumeText = row.sessionId
      ? decision === 'approve'
        ? `Your pending approval to run ${row.actionPath} was approved — continue.`
        : `Your request to run ${row.actionPath} was denied — continue without it.`
      : null;
    const callbackValues =
      row.sessionId && resumeText
      ? buildContinueSessionCommandValues({
          source: 'system:approval-resume',
          projectId,
          accountId: loaded.row.accountId,
          sessionId: row.sessionId,
          actorUserId: loaded.userId,
          text: resumeText,
          executionId,
          availableAt: new Date(),
          idempotencyKey: `approval-resume:${executionId}`,
        })
      : null;
    const resolved = await db.transaction(async (tx) => {
      const updated = await tx
        .update(connectorCalls)
        .set({
          status: decision === 'approve' ? 'ok' : 'denied',
          approvedBy: loaded.userId,
          resolvedAt: new Date(),
          resultSummary: detail,
        })
        .where(
          and(
            eq(connectorCalls.executionId, executionId),
            eq(connectorCalls.projectId, projectId),
            eq(connectorCalls.status, 'pending_approval'),
            isNull(connectorCalls.approvedBy),
            isNull(connectorCalls.resolvedAt),
          ),
        )
        .returning({ id: connectorCalls.executionId });
      if (updated.length > 0 && callbackValues) {
        await tx
          .insert(sessionLifecycleCommands)
          .values(callbackValues)
          .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
      }
      return updated;
    });

    if (resolved.length === 0) {
      return c.json({ error: 'Approval already resolved' }, 409);
    }

    try {
      await recordAuditEvent(
        approvalResolvedAuditEvent({
          accountId: loaded.row.accountId,
          projectId,
          sessionId: row.sessionId,
          executionId,
          actorUserId: loaded.userId,
          actionPath: row.actionPath,
          connectorId: row.connectorId,
          decision,
          source: inferAuditSource(c, 'human'),
        }),
      );
    } catch (error) {
      console.error('[approvals] failed to record central audit event', error);
    }

    // Decision callback. The connector HTTP call returned the approval URL and
    // ended. A human decision now enqueues one durable continue_session command
    // and starts a drain immediately. The next exact call claims the approved
    // request digest once. A changed payload creates a new approval instead.
    if (row.sessionId) {
      // Best-effort immediate webhook-like delivery. The transaction above
      // already persisted the callback with the decision as one atomic outbox.
      void drainSessionLifecycleQueue({
        limit: 1,
        idempotencyKey: `approval-resume:${executionId}`,
      }).catch(() => {});
    }

    return c.json({ ok: true });
  },
);

// PUT /v1/projects/:projectId/sessions/:sessionId/sharing
// Owner or project manager sets who can see/open this session
// (private | project | members). Mirrors connector/secret sharing.
