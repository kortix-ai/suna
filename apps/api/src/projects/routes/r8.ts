import { checkBillingActive } from '../../billing/services/billing-gate';
import { config, type SandboxProviderName } from '../../config';
import { auth, errors, json } from '../../openapi';
import { getProvider } from '../../platform/providers';
import { provisionSessionSandbox } from '../../platform/services/session-sandbox';
import { db } from '../../shared/db';
import { getCrById, getNextCrNumber, serializeChangeRequest } from '../change-requests';
import { getBranchDiff, getDiffBetweenShas, invalidateProjectMirror, previewMerge, resolveBranchTip } from '../git';
import { createRoute, z } from '@hono/zod-openapi';
import { changeRequests, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { loadProjectForUser, loadVisibleSession } from '../lib/access';
import { AnyObject, ChangeRequestSchema, projectsApp } from '../lib/app';
import { resolveProjectGitAuth, withProjectGitAuth } from '../lib/git';
import { UUID_V4_REGEX, normalizeString, readBody } from '../lib/serializers';
import { buildSessionSandboxEnvVars, sandboxCallbackUnreachableReason } from '../lib/sessions';
import { kickProvisionOnOpen, refreshCrTips, resumeStoppedSandbox } from './shared';

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/wake',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/wake',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 402, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const wakeVisible = await loadVisibleSession(loaded, sessionId);
  if (!wakeVisible) return c.json({ error: 'Not found' }, 404);

  // Billing v2 — same gate as session create. An unsubscribed account can
  // own a stopped sandbox (e.g. they cancelled their sub after creating it),
  // but they shouldn't be able to resume it without re-activating billing.
  // Body shape mirrors createProjectSession's 402 (see note there).
  const billingCheck = await checkBillingActive(loaded.row.accountId);
  if (!billingCheck.ok) {
    return c.json(
      {
        error: billingCheck.message,
        message: billingCheck.message,
        code: billingCheck.reason,
        balance: billingCheck.balance,
      },
      402,
    );
  }

  const [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);

  // Dormant session with no sandbox yet (e.g. a migrated legacy session) —
  // provision one on open (same trigger as GET /sandbox).
  if (!row) {
    if (wakeVisible.row.status === 'stopped') {
      await kickProvisionOnOpen(loaded, wakeVisible.row, projectId, sessionId);
      return c.json({ status: 'provisioning' });
    }
    return c.json({ status: 'unknown' });
  }

  if (!row.externalId) return c.json({ status: 'unknown' });

  const providerName = row.provider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) {
    return c.json({ status: 'unknown' });
  }
  const provider = getProvider(providerName);

  let status: string;
  try {
    status = await provider.getStatus(row.externalId);
  } catch {
    return c.json({ status: 'unknown' });
  }
  if (status === 'running') return c.json({ status: 'running' });

  // Explicitly hibernated session (row status='stopped' — Stop button / idle
  // maintenance): resume IN PLACE through the shared path so the row flips back
  // to active, the session returns to 'running', and compute metering reopens.
  // Without this, a stopped row would also be a candidate for delete+reprovision
  // on the GET poll — we want resume, not a cold reboot.
  if (row.status === 'stopped') {
    await resumeStoppedSandbox({
      sandboxId: row.sandboxId,
      sessionId,
      accountId: row.accountId,
      provider: row.provider,
      externalId: row.externalId,
    });
    return c.json({ status: 'waking' });
  }

  // Idle auto-stop by the provider (DB row still reads 'active'): just kick the
  // start in the background so the caller gets an instant answer and the health
  // poll observes readiness. Don't block on the provider start (~10-30s).
  void provider.start(row.externalId).catch((err) =>
    console.warn(`[wake] failed to start sandbox ${row.externalId} (session ${sessionId}):`, err),
  );
  return c.json({ status: 'waking' });
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
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // Restart is reserved for the session owner or a project manager.
  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
    return c.json({ error: 'Only the session owner or a project manager can restart this session' }, 403);
  }
  const session = visible.row;

  const providerName = session.sandboxProvider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) {
    return c.json({ error: `Restart is not supported for provider ${providerName}` }, 400);
  }

  // Same loopback-callback guard as create: restarting into an unreachable
  // KORTIX_URL just rebuilds the same dead sandbox.
  const restartUnreachable = sandboxCallbackUnreachableReason();
  if (restartUnreachable) {
    return c.json({ error: restartUnreachable, code: 'KORTIX_URL_UNREACHABLE' }, 503);
  }

  const [existingSandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sessionId))
    .limit(1);

  // In-place restart: reboot the EXISTING box via the provider SDK (stop+start)
  // instead of destroying + cold-reprovisioning it. The disk — repo clone,
  // installed deps, opencode — persists across a stop/start, so this is a fast
  // reboot, not a cold boot, and we NEVER remove the box (removal is reserved
  // for explicit session deletion). The same compute row and sandbox keys carry
  // over, so there's nothing to finalize or rotate.
  if (existingSandbox?.externalId
      && (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(existingSandbox.provider)) {
    const externalId = existingSandbox.externalId;
    const provider = getProvider(existingSandbox.provider as SandboxProviderName);
    // Flip to provisioning so the dashboard's connecting screen re-engages while
    // the VM reboots; GET …/sandbox keeps returning the row ('provisioning' is a
    // usable state) so no reprovision is triggered underneath us.
    await db.update(sessionSandboxes)
      .set({ status: 'provisioning', updatedAt: new Date() })
      .where(eq(sessionSandboxes.sandboxId, sessionId));
    await db.update(projectSessions)
      .set({ status: 'provisioning', error: null, sandboxUrl: null, updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, sessionId));
    void (async () => {
      try {
        await provider.stop(externalId).catch(() => {}); // best-effort clean down→up cycle
        await provider.start(externalId);
        await db.update(sessionSandboxes)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(sessionSandboxes.sandboxId, sessionId));
        await db.update(projectSessions)
          .set({ status: 'running', updatedAt: new Date() })
          .where(eq(projectSessions.sessionId, sessionId));
      } catch (err) {
        console.warn(`[projects] restart-in-place failed for ${sessionId}:`, err);
        // Leave it resumable — a 'stopped' row reopens via the GET resume path.
        await db.update(sessionSandboxes)
          .set({ status: 'stopped', updatedAt: new Date() })
          .where(eq(sessionSandboxes.sandboxId, sessionId)).catch(() => {});
        await db.update(projectSessions)
          .set({ status: 'stopped', updatedAt: new Date() })
          .where(eq(projectSessions.sessionId, sessionId)).catch(() => {});
      }
    })();
    return c.json({ ok: true, session_id: sessionId, status: 'provisioning' }, 202);
  }

  // No existing box (deleted / never provisioned) → provision a fresh one so
  // restart still recovers a dead session from the preserved git branch.
  const gitAuth = await resolveProjectGitAuth(loaded.row);
  const initialPrompt = typeof session.metadata?.initial_prompt === 'string'
    ? session.metadata.initial_prompt as string
    : null;
  const opencodeModel = typeof session.metadata?.opencode_model === 'string'
    ? session.metadata.opencode_model as string
    : null;

  await db
    .update(projectSessions)
    .set({ status: 'provisioning', error: null, sandboxUrl: null, updatedAt: new Date() })
    .where(eq(projectSessions.sessionId, sessionId));

  // Fire-and-forget the actual re-provision. Same shape as session-create.
  void (async () => {
    try {
      const extraEnvVars = await buildSessionSandboxEnvVars({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
        userId: loaded.userId,
        repoUrl: loaded.row.repoUrl,
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
        agentName: session.agentName ?? 'default',
        initialPrompt,
        opencodeModel,
      });
      await provisionSessionSandbox({
        sandboxId: sessionId,
        accountId: loaded.row.accountId,
        projectId,
        userId: loaded.userId,
        provider: providerName,
        metadata: {
          session_id: sessionId,
          project_id: projectId,
          restarted_at: new Date().toISOString(),
        },
        extraEnvVars,
        gitProject: {
          projectId,
          repoUrl: loaded.row.repoUrl,
          defaultBranch: loaded.row.defaultBranch,
          manifestPath: loaded.row.manifestPath,
          gitAuthToken: gitAuth.auth?.token ?? null,
        },
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
      });
    } catch (err) {
      const message = (err as Error)?.message || 'Sandbox restart failed';
      console.error(`[projects] restart: provisioning failed for ${sessionId}:`, err);
      await db
        .update(projectSessions)
        .set({ status: 'failed', error: message, updatedAt: new Date() })
        .where(eq(projectSessions.sessionId, sessionId))
        .catch(() => {});
    }
  })();

  return c.json({ ok: true, session_id: sessionId, status: 'provisioning' }, 202);
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
    whereClauses.push(eq(changeRequests.status, statusFilter as 'open' | 'merged' | 'closed'));
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
        ...errors(400, 404, 500),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const title = normalizeString(body.title);
  if (!title) return c.json({ error: 'title is required' }, 400);
  const description = normalizeString(body.description) ?? '';
  const headRef = normalizeString(body.head_ref ?? body.headRef);
  if (!headRef) return c.json({ error: 'head_ref is required' }, 400);
  const baseRef = normalizeString(body.base_ref ?? body.baseRef) ?? loaded.row.defaultBranch;
  if (baseRef === headRef) {
    return c.json({ error: 'head_ref and base_ref must differ' }, 400);
  }

  let originSessionId: string | null = normalizeString(body.session_id ?? body.sessionId);
  if (originSessionId) {
    const [sessionRow] = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(and(eq(projectSessions.sessionId, originSessionId), eq(projectSessions.projectId, projectId)))
      .limit(1);
    if (!sessionRow) originSessionId = null;
  }

  // Resolve current tips so the CR has anchored SHAs from the start.
  let baseSha: string | null = null;
  let headSha: string | null = null;
  try {
    const projectForGit = await withProjectGitAuth(loaded.row);
    [baseSha, headSha] = await Promise.all([
      resolveBranchTip(projectForGit, baseRef),
      resolveBranchTip(projectForGit, headRef),
    ]);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to resolve branches',
    }, 400);
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
  if (!inserted) return c.json({ error: 'Failed to allocate CR number' }, 500);

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

  const body = await readBody(c);
  const message = normalizeString(body.message) ?? undefined;

  const [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);
  if (!row || !row.externalId) {
    return c.json({ error: 'Session sandbox not found' }, 404);
  }
  if (row.status !== 'active') {
    return c.json({ error: 'Session sandbox is not running', status: row.status }, 409);
  }

  const providerName = row.provider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) {
    return c.json({ error: 'Unsupported sandbox provider' }, 409);
  }

  // resolveEndpoint already injects the sandbox service key as a Bearer token
  // (and the Daytona preview headers), which the daemon's /kortix/git route
  // validates against KORTIX_TOKEN — same contract as /kortix/env.
  let endpoint: { url: string; headers: Record<string, string> };
  try {
    endpoint = await getProvider(providerName).resolveEndpoint(row.externalId);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Failed to reach sandbox' },
      502,
    );
  }

  let daemonRes: Response;
  try {
    daemonRes = await fetch(`${endpoint.url.replace(/\/$/, '')}/kortix/git/commit-push`, {
      method: 'POST',
      headers: endpoint.headers,
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Sandbox unreachable' },
      502,
    );
  }

  const result = (await daemonRes.json().catch(() => null)) as
    | {
        ok?: boolean;
        committed?: boolean;
        pushed?: boolean;
        nothingToDo?: boolean;
        branch?: string | null;
        headSha?: string | null;
        message?: string;
      }
    | null;

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

  const cr = await getCrById(crId, projectId);
  if (!cr) return c.json({ error: 'Change request not found' }, 404);
  if (cr.status !== 'open') {
    return c.json({ error: `Cannot edit a ${cr.status} change request` }, 409);
  }

  const updates: Partial<typeof changeRequests.$inferInsert> = { updatedAt: new Date() };
  const title = normalizeString(body.title);
  if (title) updates.title = title;
  if (typeof body.description === 'string') updates.description = body.description;

  const [row] = await db
    .update(changeRequests)
    .set(updates)
    .where(eq(changeRequests.crId, crId))
    .returning();
  return c.json(serializeChangeRequest(row));
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
    const useSnapshot = cr.status === 'merged' && cr.baseCommitSha && cr.headCommitSha;
    const diff = useSnapshot
      ? await getDiffBetweenShas(projectForGit, cr.baseCommitSha!, cr.headCommitSha!)
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
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to compute diff',
    }, 400);
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
    const preview = await previewMerge(await withProjectGitAuth(loaded.row), cr.baseRef, cr.headRef);
    return c.json(preview);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to preview merge',
    }, 400);
  }
},
);

// POST /v1/projects/:projectId/change-requests/:crId/merge
// Body: { message?: string }
