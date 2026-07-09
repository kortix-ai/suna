import { checkBillingActive } from '../../billing/services/billing-gate';
import { config, type SandboxProviderName } from '../../config';
import { auth, errors, json } from '../../openapi';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import {
  getCrById,
  getNextCrNumber,
  recordRequestedChange,
  serializeChangeRequest,
} from '../change-requests';
import {
  getBranchDiff,
  getDiffBetweenShas,
  invalidateProjectMirror,
  previewMerge,
  resolveBranchAheadState,
} from '../git';
import { createRoute, z } from '@hono/zod-openapi';
import { changeRequests, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability } from '../lib/access';
import { assertAgentScope } from '../../iam/agent-scope';
import { PROJECT_ACTIONS } from '../../iam';
import { AnyObject, ChangeRequestSchema, SessionStartResultSchema, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { UUID_V4_REGEX, normalizeString, readBody } from '../lib/serializers';
import { continueSession, restartSession, startSession, stopSession } from '../session-lifecycle';
import {
  refreshCrTips,
} from './shared';

// POST /v1/projects/:projectId/sessions/:sessionId/start
// THE unified session-open endpoint. One idempotent call that provisions a
// missing sandbox, resumes a hibernated/idle one, and resolves the OpenCode pin
// once reachable — returning a single readiness payload { stage, sandbox,
// opencode_session_id, retriable } the client polls until stage='ready'.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/start',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/start',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(SessionStartResultSchema, 'Session readiness payload'),
      ...errors(400, 402, 404),
    },
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId))
      return c.json({ error: 'Invalid session id' }, 400);

    // Floor 'session' (= project.session.start) so the human gate matches
    // restart/stop and a custom role that withholds session.start is denied here
    // (was 'read', which let any project-reader start sessions).
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: resuming a session provisions compute. A scoped agent
    // token must hold project.session.start (no-op for human/PAT tokens).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    const visible = await loadVisibleSession(loaded, sessionId);
    if (!visible) return c.json({ error: 'Not found' }, 404);

    // Same gate as wake/create: resuming or provisioning spends compute.
    const billing = await checkBillingActive(loaded.row.accountId);
    if (!billing.ok) {
      return c.json(
        {
          error: billing.message,
          message: billing.message,
          code: billing.reason,
          balance: billing.balance,
        },
        402,
      );
    }

    // Optional server-side long-poll: the web client passes ?wait_ms so the
    // server holds the request until readiness flips (or a bounded deadline),
    // killing the ~800ms client poll-tick latency. Clamped; omitted = one-shot.
    const waitMsRaw = Number(c.req.query('wait_ms'));
    const waitMs = Number.isFinite(waitMsRaw) && waitMsRaw > 0 ? Math.min(waitMsRaw, 8000) : 0;
    const result = await startSession({ source: 'ui', loaded, visible, projectId, sessionId, waitMs });
    return c.json(result.start, 200);
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/restart
// Reboot the existing sandbox in place via the provider SDK (stop+start) — the
// box and its disk (repo clone, deps, opencode) are kept, never removed. Only
// when the session has no sandbox (deleted / never provisioned) do we provision
// a fresh one to recover it from the preserved git branch.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/restart',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/restart',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      202: json(z.any(), 'OK'),
      ...errors(400, 403, 404, 503),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId))
      return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: restart re-provisions compute. A scoped agent token must
    // hold project.session.start (no-op for human/PAT tokens).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);

    // Restart is reserved for the session owner or an account owner/admin.
    const visible = await loadVisibleSession(loaded, sessionId);
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (!visible.canManageSharing) {
      return c.json(
        {
          error:
            'Only the session owner or an account owner/admin can restart this session',
        },
        403,
      );
    }
    const result = await restartSession({
      loaded,
      session: visible.row,
      projectId,
      sessionId,
    });
    return c.json(result.body, result.status as any);
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/stop
// Manual pause: stops the running sandbox in place (disk kept, same contract as
// an idle auto-stop) without provisioning anything new. Resumable via /start.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/stop',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/stop',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId))
      return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: same capability as start/restart — stopping is part of
    // the agent's session-lifecycle surface.
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    // Human gate: stopping has its own leaf (project.session.stop), distinct from
    // start, so a custom role can allow one and withhold the other. Every
    // built-in role holds it, so member/editor/manager are unaffected.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_STOP);

    // Stop is reserved for the session owner or an account owner/admin, same policy
    // as restart.
    const visible = await loadVisibleSession(loaded, sessionId);
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (!visible.canManageSharing) {
      return c.json(
        { error: 'Only the session owner or an account owner/admin can stop this session' },
        403,
      );
    }

    const result = await stopSession({
      projectId,
      sessionId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
    });
    return c.json(result.body, result.status as any);
  },
);

// ─── Change Requests ────────────────────────────────────────────────────────
// Kortix-native PR layer. The CR is metadata stored alongside the project;
// the underlying merge runs through ./git.ts which works against any git
// backend (GitHub, GitLab, plain git) — so the merge UI lives in
// Kortix even when the repo is hosted elsewhere.
//
// v1 is intentionally minimal: open / merged / closed, head_ref + base_ref,
// head/base commit SHAs auto-refreshed on read. No reviews, no comments,
// no mirrored revision history — git remains the source of truth.

/**
 * Refresh the CR's cached head/base SHAs against the live git tips. Used by
 * read endpoints so the UI never shows stale "X commits behind" state. No-op
 * when the SHAs already match or the CR is no longer open.
 */

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/change-requests',
    tags: ['change-requests'],
    summary: 'GET /:projectId/change-requests',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({}).passthrough(),
    },
    responses: {
      200: json(z.array(ChangeRequestSchema), 'Change requests'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const statusFilter = normalizeString(c.req.query('status'))?.toLowerCase();
    const whereClauses = [eq(changeRequests.projectId, projectId)];
    if (statusFilter && statusFilter !== 'all') {
      if (!['open', 'merged', 'closed'].includes(statusFilter)) {
        return c.json({ error: 'Invalid status filter' }, 400);
      }
      whereClauses.push(
        eq(changeRequests.status, statusFilter as 'open' | 'merged' | 'closed'),
      );
    }

    const rows = await db
      .select()
      .from(changeRequests)
      .where(and(...whereClauses))
      .orderBy(desc(changeRequests.number));

    return c.json({
      change_requests: rows.map(serializeChangeRequest),
    });
  },
);

// POST /v1/projects/:projectId/change-requests
// Body: { title, description?, head_ref, base_ref?, session_id? }

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/change-requests',
    tags: ['change-requests'],
    summary: 'POST /:projectId/change-requests',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(ChangeRequestSchema, 'The created change request'),
      ...errors(400, 404, 422, 500),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Human-side capability gate (Git Ops). Editors hold it; a custom
    // role omits project.gitops.push to take Git-Ops away from a department.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH);

    // Per-agent gate: opening a CR is the agent's intended path to propose work.
    // Default-deny — a scoped agent must be granted project.cr.open.
    assertAgentScope(c, 'project.cr.open');

    const title = normalizeString(body.title);
    if (!title) return c.json({ error: 'title is required' }, 400);
    const description = normalizeString(body.description) ?? '';
    const headRef = normalizeString(body.head_ref ?? body.headRef);
    if (!headRef) return c.json({ error: 'head_ref is required' }, 400);
    const baseRef =
      normalizeString(body.base_ref ?? body.baseRef) ??
      loaded.row.defaultBranch;
    if (baseRef === headRef) {
      return c.json({ error: 'head_ref and base_ref must differ' }, 400);
    }

    let originSessionId: string | null = normalizeString(
      body.session_id ?? body.sessionId,
    );
    if (originSessionId) {
      const [sessionRow] = await db
        .select({ sessionId: projectSessions.sessionId })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.sessionId, originSessionId),
            eq(projectSessions.projectId, projectId),
          ),
        )
        .limit(1);
      if (!sessionRow) originSessionId = null;
    }

    // Resolve current tips so the CR has anchored SHAs from the start, and
    // refuse an EMPTY change request outright: a head with no commits ahead
    // of base renders "No changes detected" in the dashboard and can never
    // be applied (previewMerge reports it un-mergeable). The two shapes are
    // a committed-but-never-pushed session branch (head tip == base tip) and
    // a stale branch behind an advanced base (merge-base == head tip); both
    // came up in the wild via agent flows on 2026-07-06. The resolver forces
    // a mirror re-fetch before concluding "not ahead", so a push that landed
    // moments ago never bounces.
    let baseSha: string | null = null;
    let headSha: string | null = null;
    let headAhead = true;
    try {
      const projectForGit = await withProjectGitAuth(loaded.row);
      const aheadState = await resolveBranchAheadState(projectForGit, baseRef, headRef);
      baseSha = aheadState.baseSha;
      headSha = aheadState.headSha;
      headAhead = aheadState.ahead;
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to resolve branches',
        },
        400,
      );
    }
    if (!headAhead) {
      return c.json(
        {
          error: `head_ref "${headRef}" has no commits ahead of "${baseRef}" — the change request would be empty and could never be applied. Commit your work and push the branch (git push origin HEAD), then retry. If your branch is behind an advanced base, rebase onto the latest base first.`,
          code: 'CR_HEAD_NOT_AHEAD',
        },
        422,
      );
    }

    // Atomically allocate the next per-project number and insert. Retry once on
    // unique-constraint collision (only happens under racing opens).
    let inserted: typeof changeRequests.$inferSelect | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const number = await getNextCrNumber(projectId);
      try {
        const [row] = await db
          .insert(changeRequests)
          .values({
            accountId: loaded.row.accountId,
            projectId,
            number,
            title,
            description,
            baseRef,
            headRef,
            headCommitSha: headSha,
            baseCommitSha: baseSha,
            originSessionId,
            createdBy: loaded.userId,
          })
          .returning();
        inserted = row;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate key/.test(message)) throw error;
      }
    }
    if (!inserted)
      return c.json({ error: 'Failed to allocate CR number' }, 500);

    return c.json(serializeChangeRequest(inserted), 201);
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/commit-push
// Commits the session sandbox's working-tree changes and pushes them to the
// session branch — the host-driven path that lets the dashboard open a change
// request without routing through the agent. Idempotent: a clean tree with
// nothing left to push returns { nothing_to_do: true }.
//
// NOTE (2026-05-29): currently UNUSED by the UI. The shipped change-request
// flow lets the agent commit + open the CR from a single chat prompt instead.
// Kept (wired through to the daemon /kortix/git/commit-push route) as the
// host-driven primitive for a possible fully-UI flow. Remove together with the
// daemon route + web client/hook if that direction is dropped.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/commit-push',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/commit-push',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH);

    const body = await readBody(c);
    const message = normalizeString(body.message) ?? undefined;

    const [row] = await db
      .select()
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sessionId, sessionId),
          eq(sessionSandboxes.projectId, projectId),
          eq(sessionSandboxes.accountId, loaded.row.accountId),
        ),
      )
      .limit(1);
    if (!row || !row.externalId) {
      return c.json({ error: 'Session sandbox not found' }, 404);
    }
    if (row.status !== 'active') {
      return c.json(
        { error: 'Session sandbox is not running', status: row.status },
        409,
      );
    }

    const providerName = row.provider as SandboxProviderName;
    if (
      !(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(
        providerName,
      )
    ) {
      return c.json({ error: 'Unsupported sandbox provider' }, 409);
    }

    // resolveEndpoint already injects the sandbox service key as a Bearer token
    // (and the Daytona preview headers), which the daemon's /kortix/git route
    // validates against KORTIX_TOKEN — same contract as /kortix/env.
    let endpoint: { url: string; headers: Record<string, string> };
    try {
      endpoint = await getProvider(providerName).resolveEndpoint(
        row.externalId,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : 'Failed to reach sandbox',
        },
        502,
      );
    }

    let daemonRes: Response;
    try {
      daemonRes = await fetch(
        `${endpoint.url.replace(/\/$/, '')}/kortix/git/commit-push`,
        {
          method: 'POST',
          headers: endpoint.headers,
          body: JSON.stringify({ message }),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Sandbox unreachable',
        },
        502,
      );
    }

    const result = (await daemonRes.json().catch(() => null)) as {
      ok?: boolean;
      committed?: boolean;
      pushed?: boolean;
      nothingToDo?: boolean;
      branch?: string | null;
      headSha?: string | null;
      message?: string;
    } | null;

    if (!daemonRes.ok || !result?.ok) {
      return c.json(
        { error: result?.message || 'Failed to save changes' },
        daemonRes.status === 409 ? 409 : 502,
      );
    }

    // A fresh commit just landed on the session branch and was pushed to origin.
    // Force the next mirror read to re-fetch so the CR we open immediately after
    // sees the new tip (the mirror is otherwise refresh-throttled).
    invalidateProjectMirror(projectId);

    return c.json({
      committed: Boolean(result.committed),
      pushed: Boolean(result.pushed),
      nothing_to_do: Boolean(result.nothingToDo),
      branch: result.branch ?? null,
      head_sha: result.headSha ?? null,
    });
  },
);

// GET /v1/projects/:projectId/change-requests/:crId
// Auto-refreshes the cached head/base SHAs against the live git tips so the
// UI never shows stale "X commits behind" state.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/change-requests/{crId}',
    tags: ['change-requests'],
    summary: 'GET /:projectId/change-requests/:crId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(ChangeRequestSchema, 'The change request'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    let cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);

    await refreshCrTips({
      cr,
      project: await withProjectGitAuth(loaded.row),
    });
    cr = (await getCrById(crId, projectId))!;

    return c.json({ change_request: serializeChangeRequest(cr) });
  },
);

// PATCH /v1/projects/:projectId/change-requests/:crId
// Body: { title?, description? }

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/change-requests/{crId}',
    tags: ['change-requests'],
    summary: 'PATCH /:projectId/change-requests/:crId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: editing a CR is part of the change-request capability.
    assertAgentScope(c, 'project.cr.open');

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);
    if (cr.status !== 'open') {
      return c.json(
        { error: `Cannot edit a ${cr.status} change request` },
        409,
      );
    }

    const updates: Partial<typeof changeRequests.$inferInsert> = {
      updatedAt: new Date(),
    };
    const title = normalizeString(body.title);
    if (title) updates.title = title;
    if (typeof body.description === 'string')
      updates.description = body.description;

    const [row] = await db
      .update(changeRequests)
      .set(updates)
      .where(eq(changeRequests.crId, crId))
      .returning();
    return c.json(serializeChangeRequest(row));
  },
);

// POST /v1/projects/:projectId/change-requests/:crId/request-changes
// Human "request changes" from the Review Center: persist the feedback on the CR
// (CRs have no comment table — this is how the ask is remembered + shown back)
// and deliver it to the agent that opened the change so it revises. Delivery is
// fire-and-forget: continueSession boots the sandbox if it's asleep, resolves the
// live session, and retries — so the HTTP response stays snappy.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/change-requests/{crId}/request-changes',
    tags: ['change-requests'],
    summary: 'POST /:projectId/change-requests/:crId/request-changes',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // request-changes is a human review decision on a CR, not a code push —
    // gate it on project.review.act (the same leaf as /review/items/{id}/act),
    // not gitops.push. Editor/manager hold both; a custom reviewer role with
    // review.act but no gitops.push can now request changes.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
    );

    const feedback = normalizeString(body.feedback ?? body.text);
    if (!feedback) return c.json({ error: 'feedback is required' }, 400);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);
    if (cr.status !== 'open') {
      return c.json({ error: `Cannot request changes on a ${cr.status} change request` }, 409);
    }

    // Persist first — the ask must survive even if delivery can't reach the agent.
    const row = await recordRequestedChange(crId, projectId, {
      text: feedback,
      by: loaded.userId,
      at: new Date().toISOString(),
    });
    if (!row) return c.json({ error: 'Change request not found' }, 404);

    // Deliver to the originating session's agent (best-effort, background — a
    // sandbox boot can take seconds, so we never block the response on it).
    const willDeliver = Boolean(cr.originSessionId);
    if (cr.originSessionId) {
      void continueSession({
        source: 'ui',
        sessionId: cr.originSessionId,
        text: `Please revise change request #${cr.number} ("${cr.title}") based on this feedback:\n\n${feedback}`,
        userId: loaded.userId,
      }).catch((err) => {
        console.warn('[change-requests] request-changes delivery failed', {
          crId,
          error: String(err),
        });
      });
    }

    return c.json({ change_request: serializeChangeRequest(row), delivering: willDeliver });
  },
);

// GET /v1/projects/:projectId/change-requests/:crId/diff
// For open / closed CRs: lives off the live branch tips (three-dot diff).
// For merged CRs: uses the SHAs captured at merge time, so the diff still
// renders even though the head branch is now fully reachable from base.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/change-requests/{crId}/diff',
    tags: ['change-requests'],
    summary: 'GET /:projectId/change-requests/:crId/diff',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);

    const projectForGit = await withProjectGitAuth(loaded.row);

    try {
      const useSnapshot =
        cr.status === 'merged' && cr.baseCommitSha && cr.headCommitSha;
      const diff = useSnapshot
        ? await getDiffBetweenShas(
            projectForGit,
            cr.baseCommitSha!,
            cr.headCommitSha!,
          )
        : await getBranchDiff(projectForGit, cr.baseRef, cr.headRef);
      return c.json({
        cr_id: cr.crId,
        base_ref: cr.baseRef,
        head_ref: cr.headRef,
        base_sha: diff.base_sha,
        head_sha: diff.head_sha,
        merge_base: diff.merge_base,
        files: diff.files,
        files_changed: diff.files_changed,
        additions: diff.additions,
        deletions: diff.deletions,
        patch: diff.patch,
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : 'Failed to compute diff',
        },
        400,
      );
    }
  },
);

// GET /v1/projects/:projectId/change-requests/:crId/merge-preview

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/change-requests/{crId}/merge-preview',
    tags: ['change-requests'],
    summary: 'GET /:projectId/change-requests/:crId/merge-preview',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);

    try {
      const preview = await previewMerge(
        await withProjectGitAuth(loaded.row),
        cr.baseRef,
        cr.headRef,
      );
      return c.json(preview);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : 'Failed to preview merge',
        },
        400,
      );
    }
  },
);

// POST /v1/projects/:projectId/change-requests/:crId/merge
// Body: { message?: string }
