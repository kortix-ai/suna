/**
 * The approval inbox: connector actions a policy gated as `require_approval`,
 * the per-session "needs input" summary, and the resolve endpoint.
 */

import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json, lenientBody } from '../../openapi';
import { db } from '../../shared/db';
import { inferAuditSource } from '../../shared/audit';
import { createRoute, z } from '@hono/zod-openapi';
import { connectorCalls, projectSessions, sessionPendingQuestions } from '@kortix/db';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  mayResolveApproval,
  maySeeSessionApprovals,
} from '../lib/approval-authority';
import { loadProjectForUser, lookupEmailsByUserIds, assertProjectCapability } from '../lib/access';
import { isUuid } from '../../shared/validate';
import { AnyObject, OkSchema, projectsApp } from '../lib/app';
import {
  normalizeString,
  parseBoundedPositiveInt,
} from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import {
  approvalTargetSession,
  decideConnectorApproval,
  isPendingApproval,
  loadApprovalRow,
  normalizeApprovalNote,
} from '../lib/connector-approval-decision';
import { markApprovalCardDecided } from '../../channels/approval-card-relay';
import { callerKortixSessionId } from '../../middleware/caller-session';

export function registerApprovalsRoutes(): void {
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
      summary: 'List approvals of a project',
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
  // LAUNCHED (mirrors who may resolve). Open agent questions count too, for the
  // same principals.
  // Read-gated + cheap enough to poll.

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/approvals/needs-input',
      tags: ['access'],
      summary: 'List approvals waiting for input',
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

      // Open agent questions (`question` tool) wait on a human too, and survive
      // their sandbox (`session_pending_questions`). Counted beside approvals.
      const questionRows = await db
        .select({ sessionId: sessionPendingQuestions.sessionId })
        .from(sessionPendingQuestions)
        .where(
          and(
            eq(sessionPendingQuestions.projectId, projectId),
            isNull(sessionPendingQuestions.answeredAt),
          ),
        );

      // Count per (Kortix) session id.
      const approvalsByKortix: Record<string, number> = {};
      for (const r of pendingRows) {
        const sid = r.sessionId ? String(r.sessionId) : null;
        if (sid) approvalsByKortix[sid] = (approvalsByKortix[sid] ?? 0) + 1;
      }
      const questionsByKortix: Record<string, number> = {};
      for (const r of questionRows) {
        questionsByKortix[r.sessionId] = (questionsByKortix[r.sessionId] ?? 0) + 1;
      }
      const kortixIds = [
        ...new Set([...Object.keys(approvalsByKortix), ...Object.keys(questionsByKortix)]),
      ];
      if (kortixIds.length === 0) return c.json({ total: 0, sessions: {} });

      // Look these sessions up to (a) gate non-managers to their own and (b) map to
      // the OpenCode session id the sidebar list keys on. The response carries BOTH
      // id forms → the caller matches whichever it holds.
      const sess = await db
        .select({
          sessionId: projectSessions.sessionId,
          opencodeSessionId: projectSessions.runtimeSessionId,
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
        const authority = {
          isManager,
          targetSessionId: s.sessionId,
          targetSessionOrigin: s.origin ?? null,
          targetSessionCreatedBy: s.createdBy,
          callerUserId: loaded.userId,
          callerSessionId: callerKortixSessionId(c),
        };
        const n = maySeeSessionApprovals(authority)
          ? (approvalsByKortix[s.sessionId] ?? 0) + (questionsByKortix[s.sessionId] ?? 0)
          : 0;
        if (n <= 0) continue;
        sessions[s.sessionId] = n;
        if (s.opencodeSessionId) sessions[s.opencodeSessionId] = n;
        total += n;
      }
      return c.json({ total, sessions });
    },
  );

  // POST /v1/projects/:projectId/approvals/:executionId
  // Resolve a pending approval — { decision: 'approve' | 'deny', note?: string }. Allowed for a
  // project MANAGER or the LAUNCHER of the session the action belongs to (the two
  // principals a human-in-the-loop approval should recognise). Records who decided
  // + when; idempotent-safe (a non-pending row 409s).

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/approvals/{executionId}',
      tags: ['access'],
      summary: 'Approve or deny a gated action',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), executionId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            decision: z.enum(['approve', 'deny']).openapi({ description: 'Approve or deny exactly this gated call.' }),
            note: z.string().optional().openapi({ description: 'Note the agent receives with the decision.' }),
          }) } } },
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
      const body = await readJsonObject(c);
      const decision = normalizeString(body.decision);
      if (decision !== 'approve' && decision !== 'deny') {
        return c.json({ error: "decision must be 'approve' or 'deny'" }, 400);
      }
      // Optional message from the human to the agent ("deny — reword the second
      // paragraph"). Rides into the resume prompt so a deny can steer, not just stop.
      const note = normalizeApprovalNote(body.note);
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

      const row = await loadApprovalRow(projectId, executionId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      if (!isPendingApproval(row)) {
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
      const target = await approvalTargetSession(projectId, row);
      const verdict = mayResolveApproval({
        isManager,
        targetSessionOrigin: target.origin,
        targetSessionCreatedBy: target.createdBy,
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

      const outcome = await decideConnectorApproval({
        projectId,
        accountId: loaded.row.accountId,
        row,
        decision,
        note,
        actorUserId: loaded.userId,
        auditSource: inferAuditSource(c.get('authType'), 'human'),
        resume: 'queue',
        updateStaleCard: () =>
          markApprovalCardDecided({ projectId, row, decision, note, actorUserId: loaded.userId }),
      });
      if (outcome === 'preview_unavailable') {
        return c.json(
          {
            error: 'This call recorded no parameters to review, so it cannot be approved',
            code: 'APPROVAL_PREVIEW_UNAVAILABLE',
          },
          409,
        );
      }
      if (outcome === 'already_resolved') {
        return c.json({ error: 'Approval already resolved' }, 409);
      }

      return c.json({ ok: true });
    },
  );
}

// PUT /v1/projects/:projectId/sessions/:sessionId/sharing
// Owner or project manager sets who can see/open this session
// (private | project | members). Mirrors connector/secret sharing.
