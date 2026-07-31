import { executorConnectors, executorExecutions, projectSessions, projects } from '@kortix/db';
/**
 * Approval links — the AUTHENTICATED half, mounted at /v1/approval-links.
 *
 * When a policy gates a call, the gateway mints a link (see mintSetupLink's
 * `approval` kind) that resolves to a standalone page: open it in the platform,
 * or follow it from wherever it was relayed (chat, email), sign in, and decide.
 *
 * ─── WHY THIS IS NOT IN public-app.ts ───────────────────────────────────────
 * The secret/connector links are deliberately unauthenticated: their token IS a
 * value-only, short-lived bearer capability, and a teammate must be able to fill
 * one in from a phone. An APPROVAL is the opposite shape. The whole point of the
 * gate is that a HUMAN WITH AUTHORITY decides; a bearer-capability approval link
 * would let anyone holding the URL authorise exactly the action the gate exists
 * to stop — strictly worse than no gate, because it also looks governed.
 *
 * So the token here is only a POINTER to "which decision is being asked". Every
 * route requires a signed-in Kortix account and re-checks that the account may
 * act on this project (`mayResolveApproval`: a manager, or the session's
 * launcher — never a session-bound/agent credential).
 *
 * This app is READ-ONLY. The decision itself is POSTed by the page to the
 * existing POST /v1/projects/:projectId/approvals/:executionId, so there is
 * exactly ONE implementation of the resolve path (atomic CAS, audit stamping,
 * "an agent cannot approve its own call") and this never becomes a second,
 * subtly-weaker door to it.
 */
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { summarizeArgsPreview } from '../executor/args-preview';
import { PROJECT_ACTIONS } from '../iam';
import { assertProjectCapability, loadProjectForUser } from '../projects/lib/access';
import { mayResolveApproval } from '../projects/lib/approval-authority';
import { callerKortixSessionId } from '../projects/lib/caller-session';
import { db } from '../shared/db';
import { resolveSetupLink } from './token';

const approvalLinksApp = new Hono();

/** GET /v1/approval-links/:token — what am I being asked to approve? */
approvalLinksApp.get('/:token', async (c) => {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  if (resolved.payload.kind !== 'approval') return c.json({ error: 'Wrong link type' }, 400);

  const { projectId } = resolved;
  const executionId = resolved.payload.eid;

  // Membership floor. 404 (not 403) for a non-member: the link should not
  // confirm that a given project or approval exists to someone outside it.
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [row] = await db
    .select({
      executionId: executorExecutions.executionId,
      sessionId: executorExecutions.sessionId,
      actionPath: executorExecutions.actionPath,
      connectorId: executorExecutions.connectorId,
      status: executorExecutions.status,
      risk: executorExecutions.risk,
      resultSummary: executorExecutions.resultSummary,
      createdAt: executorExecutions.createdAt,
      resolvedAt: executorExecutions.resolvedAt,
    })
    .from(executorExecutions)
    .where(
      and(
        eq(executorExecutions.executionId, executionId),
        eq(executorExecutions.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: 'Not found' }, 404);

  // Same authority test as the resolve endpoint — applied to the READ too,
  // because `args_preview` can carry the content of the pending action.
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

  let targetCreatedBy: string | null = null;
  let targetOrigin: string | null = null;
  if (row.sessionId) {
    const [session] = await db
      .select({ createdBy: projectSessions.createdBy, origin: projectSessions.origin })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, row.sessionId), eq(projectSessions.projectId, projectId)),
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
    callerSessionId: callerKortixSessionId(c),
  });
  if (!verdict.allowed) {
    return c.json(
      verdict.reason === 'session_bound_caller'
        ? {
            error: 'An agent cannot resolve its own approval — a human must approve or deny this',
            code: 'APPROVAL_REQUIRES_HUMAN',
          }
        : { error: 'Only a project manager or the session launcher can resolve this' },
      403,
    );
  }

  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);

  let connectorSlug: string | null = null;
  if (row.connectorId) {
    const [connector] = await db
      .select({ slug: executorConnectors.slug })
      .from(executorConnectors)
      .where(eq(executorConnectors.connectorId, row.connectorId))
      .limit(1);
    connectorSlug = connector?.slug ?? null;
  }

  const summary =
    typeof row.resultSummary === 'object' && row.resultSummary
      ? (row.resultSummary as Record<string, unknown>)
      : {};
  const argsPreview =
    typeof summary.args_preview === 'object' && summary.args_preview
      ? (summary.args_preview as Record<string, unknown>)
      : null;

  return c.json({
    kind: 'approval',
    project_id: projectId,
    project_name: project?.name ?? 'this project',
    execution_id: row.executionId,
    session_id: row.sessionId,
    action: row.actionPath,
    connector: connectorSlug,
    risk: row.risk,
    // 'pending_approval' = still actionable. Anything else means someone (or the
    // hold expiring) already settled it; the page renders a read-only outcome
    // rather than buttons that would 409.
    status: row.status,
    pending: row.status === 'pending_approval' && !row.resolvedAt,
    args_preview: argsPreview,
    args_summary: summarizeArgsPreview(argsPreview),
    policy_source: typeof summary.policy_source === 'string' ? summary.policy_source : null,
    requested_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    expires_at: new Date(resolved.payload.exp).toISOString(),
  });
});

export { approvalLinksApp };
