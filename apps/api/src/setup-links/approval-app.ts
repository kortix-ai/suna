import { connectors, connectorCalls, projects } from '@kortix/db';
import { composioToolkitLogo } from '../connectors/composio';
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
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { enrichPendingCallOnce } from '../connectors/approval-enrich-pending';
import { isApprovalExpired } from '../connectors/approval-expiry';
import { isPlainRecord, summarizeArgsPreview } from '../connectors/args-preview';
import {
  approvalCallerOf,
  approvalTargetSession,
  loadProjectForUser,
  mayResolveApproval,
} from '../projects/surface';
import { db } from '../shared/db';
import { resolveSetupLink } from './token';
import type { AppEnv } from '../types';

// AppEnv: every route here is authenticated and the project gate reads the
// auth variables the middleware sets (authType, accountId, ...).
const approvalLinksApp = makeOpenApiApp<AppEnv>();

/** What an approval link asks the signed-in human to decide. */
const ApprovalLinkSchema = z.object({
  kind: z.literal('approval'),
  project_id: z.string(),
  project_name: z.string(),
  execution_id: z.string(),
  session_id: z.string().nullable(),
  action: z.string(),
  connector: z.string().nullable(),
  connector_name: z.string().nullable(),
  connector_icon_url: z.string().nullable(),
  risk: z.string().nullable(),
  status: z.string(),
  /** Only `pending_approval` is actionable; every other status is an outcome. */
  pending: z.boolean(),
  args_preview: z.record(z.string(), z.unknown()).nullable(),
  review_complete: z.boolean(),
  args_summary: z.string().nullable(),
  approval_context: z.string().nullable(),
  /** Content Kortix read from the provider for a reference-only call
   *  (`gmail.send_draft {draft_id}` → the draft), redacted. */
  resolved_preview: z.record(z.string(), z.unknown()).nullable(),
  /** `unavailable` when that read failed or timed out. */
  resolved_error: z.string().nullable(),
  policy_source: z.string().nullable(),
  /** The agent policy set that held this call (`policy_source: policy_set`), and its agent. */
  policy_set: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  requested_at: z.string(),
  resolved_at: z.string().nullable(),
  expires_at: z.string(),
});

/** GET /v1/approval-links/:token — what am I being asked to approve? */
approvalLinksApp.openapi(createRoute({
  method: 'get',
  path: '/{token}',
  tags: ['approvals'],
  summary: 'Read the decision an approval link asks for',
  ...auth,
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: json(ApprovalLinkSchema, 'The pending decision'), ...errors(400, 403, 404, 410) },
}), async (c) => {
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
      executionId: connectorCalls.executionId,
      accountId: connectorCalls.accountId,
      projectId: connectorCalls.projectId,
      connectionId: connectorCalls.connectionId,
      sessionId: connectorCalls.sessionId,
      actingUserId: connectorCalls.actingUserId,
      actionPath: connectorCalls.actionPath,
      connectorId: connectorCalls.connectorId,
      status: connectorCalls.status,
      risk: connectorCalls.risk,
      resultSummary: connectorCalls.resultSummary,
      createdAt: connectorCalls.createdAt,
      resolvedAt: connectorCalls.resolvedAt,
      expiresAt: connectorCalls.expiresAt,
    })
    .from(connectorCalls)
    .where(
      and(
        eq(connectorCalls.executionId, executionId),
        eq(connectorCalls.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: 'Not found' }, 404);

  // Same authority test as the resolve endpoint — applied to the READ too,
  // because `args_preview` can carry the content of the pending action. The
  // same `approvalCallerOf` + target the resolve route and `can_resolve` read,
  // so this page never disagrees with them.
  const target = await approvalTargetSession(projectId, row);
  const verdict = mayResolveApproval({
    ...(await approvalCallerOf(c, loaded, projectId)),
    targetSessionOrigin: target.origin,
    targetSessionCreatedBy: target.createdBy,
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
              error: 'Sign in with a Kortix account to review this approval',
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

  // The connector's own name and logo, so the approval page can say WHICH
  // connector for any of the catalogue's thousands, not only the ones a client
  // could guess a logo for from the slug. Same source as the connect card: the
  // row's stored icon, else the Composio catalogue logo for its app.
  let connectorSlug: string | null = null;
  let connectorName: string | null = null;
  let connectorIconUrl: string | null = null;
  if (row.connectorId) {
    const [connector] = await db
      .select({ slug: connectors.slug, name: connectors.name, config: connectors.config })
      .from(connectors)
      .where(eq(connectors.connectorId, row.connectorId))
      .limit(1);
    connectorSlug = connector?.slug ?? null;
    connectorName = connector?.name ?? null;
    const config = (connector?.config ?? {}) as { icon_url?: unknown; app?: unknown };
    connectorIconUrl =
      typeof config.icon_url === 'string' && config.icon_url
        ? config.icon_url
        : typeof config.app === 'string' && config.app
          ? await composioToolkitLogo(config.app)
          : null;
  }

  const expired = isApprovalExpired(row);
  // Only reached by a caller allowed to resolve: a row held before its action
  // had an enricher reads its content once (approval-enrich-pending.ts).
  const resultSummary = await enrichPendingCallOnce(row);
  const summary =
    typeof resultSummary === 'object' && resultSummary ? (resultSummary as Record<string, unknown>) : {};
  const argsPreview =
    typeof summary.args_preview === 'object' && summary.args_preview
      ? (summary.args_preview as Record<string, unknown>)
      : null;

  return c.json({
    kind: 'approval' as const,
    project_id: projectId,
    project_name: project?.name ?? 'this project',
    execution_id: row.executionId,
    session_id: row.sessionId,
    action: row.actionPath,
    connector: connectorSlug,
    connector_name: connectorName,
    connector_icon_url: connectorIconUrl,
    risk: row.risk,
    // 'pending_approval' is actionable. Every terminal status renders a
    // read-only outcome instead of buttons that would return 409.
    // A pending row past its window reads as expired before the worker flips it.
    status: expired ? 'expired' : row.status,
    pending: row.status === 'pending_approval' && !row.resolvedAt && !expired,
    args_preview: argsPreview,
    review_complete: summary.args_preview_complete === true,
    args_summary: summarizeArgsPreview(argsPreview),
    approval_context:
      typeof summary.approval_context === 'string' ? summary.approval_context : null,
    resolved_preview: isPlainRecord(summary.resolved_preview) ? summary.resolved_preview : null,
    resolved_error: typeof summary.resolved_error === 'string' ? summary.resolved_error : null,
    policy_source: typeof summary.policy_source === 'string' ? summary.policy_source : null,
    policy_set: summary.policy_source === 'policy_set' && typeof summary.policy_set === 'string' ? summary.policy_set : null,
    agent: summary.policy_source === 'policy_set' && typeof summary.agent === 'string' ? summary.agent : null,
    requested_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    // The earlier of the link token's expiry and the approval's own window.
    expires_at: new Date(
      Math.min(resolved.payload.exp, row.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY),
    ).toISOString(),
  });
});

export { approvalLinksApp };
