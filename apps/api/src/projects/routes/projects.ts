/**
 * Projects: list, create, managed-git status, and provision. Imported first by
 * ../index.ts: its first statement registers the global `/*` auth middleware.
 */
import { projectRoleGrants } from '../../iam/read-models';
import { ACCOUNT_ACTIONS, assertAuthorized, authorize, listAccessible } from '../../iam';
import { actorOf } from '../../iam/actor';
import { setContextField } from '../../lib/request-context';
import { supabaseAuth } from '../../middleware/auth';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { kickProjectTemplatePrebuilds } from '../../snapshots/builder';
import { isAccountManager } from '../access';
import { getBackend, hasBackend } from '../git-backends';
import { buildProvisionContext, runProvision } from '../provision-core';
import { createRoute, z } from '@hono/zod-openapi';
import { projects } from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { enforceProjectQuota, resolveProjectAccount } from '../lib/access';
import { AnyObject, ProjectSchema, projectsApp } from '../lib/app';
import {
  GitHubInstallationRequiredError,
  createGitHubInstallationInstallUrl,
  resolveGitHubImport,
} from '../lib/git';
import { registerGitHubLinkedProject } from '../lib/project-registration';
import {
  deriveProjectName,
  normalizeRepoUrl,
  normalizeString,
  serializeProject,
} from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';

projectsApp.use('/*', supabaseAuth);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['projects'],
    summary: 'GET /',
    ...auth,
    responses: {
        200: json(z.array(ProjectSchema), 'Projects the caller can read'),
    },
  }),
  async (c) => {
  const scope = await resolveProjectAccount(c);
  // Reach through `any` for non-typed context keys set by the auth
  // middleware (the AppEnv only types userId/userEmail).
  // Ask the engine which projects the caller can READ. It returns one of:
  // { mode: 'all' } | { mode: 'none' } | { mode: 'allow_only' }.
  // 'all' = account admin/owner (manager on every project); 'allow_only'
  // = enumerated project ids from the caller's own assignments plus every
  // group they belong to; 'none' = no access.
  const accessible = await listAccessible(
    await actorOf(c, scope.accountId),
    'project.read',
    'project',
  );

  // Empty, whatever the reason. `account_mfa_required` cannot reach here: the
  // listing is deliberately not MFA-gated, because challenging someone for
  // opening the project switcher is worse than showing the names and
  // challenging them when they open one. `authorize` still denies every
  // per-project action with the coded 403 the step-up dialog keys on.
  if (accessible.mode === 'none') return c.json([]);

  // Build the project rows + the per-row role label the UI renders. The engine
  // answers yes/no, not "at what tier", so the caller's own direct project
  // assignments are read here — from `role_assignments`, the same store the
  // verdict above came from.
  const grants = await projectRoleGrants({
    accountId: scope.accountId,
    userId: scope.userId,
  });
  const roleByProject = new Map(grants.map((g) => [g.projectId, g.projectRole]));

  const baseWhere = and(
    eq(projects.accountId, scope.accountId),
    eq(projects.status, 'active'),
  );

  let rows: Array<typeof projects.$inferSelect>;
  if (accessible.mode === 'all') {
    rows = await db.select().from(projects).where(baseWhere).orderBy(desc(projects.updatedAt));
  } else {
    // mode === 'allow_only'. The 'none' case was returned above.
    if (accessible.allowed.size === 0) return c.json([]);
    rows = await db
      .select()
      .from(projects)
      .where(and(baseWhere, inArray(projects.projectId, [...accessible.allowed])))
      .orderBy(desc(projects.updatedAt));
  }

  // Heuristic for effective_role label (UI only, NOT auth):
  //   - account-manager → 'manager' (legacy owner/admin gets full label)
  //   - explicit project_members row → that role
  //   - otherwise → 'member' (engine allowed read but we don't know the
  //     exact role; safe minimum for UI affordances)
  const accountManager = isAccountManager(scope.accountRole);
  return c.json(
    rows.map((row) => {
      const projectRole = roleByProject.get(row.projectId) ?? null;
      const effectiveRole = accountManager
        ? 'manager'
        : projectRole ?? 'member';
      return serializeProject(row, { projectRole, effectiveRole });
    }),
  );
},
);

// POST /v1/projects

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['projects'],
    summary: 'POST /',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(ProjectSchema, 'The created project'),
        ...errors(400, 409),
    },
  }),
  async (c: any) => {
  const body = await readJsonObject(c);
  const scope = await resolveProjectAccount(c, body);
  // IAM-gated. Engine consults super-admin bypass, direct + group
  // policies, and legacy owner/admin bridges (in non-strict mode).
  await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE);

  let repoUrl: string | null;
  try {
    repoUrl = normalizeRepoUrl(body.repo_url ?? body.repoUrl);
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Invalid repo_url' }, 400);
  }
  if (!repoUrl) {
    return c.json({ error: 'repo_url is required' }, 400);
  }

  const quota = await enforceProjectQuota(c, scope.accountId);
  if (quota) return quota;

  const name = normalizeString(body.name) ?? deriveProjectName(repoUrl);
  const requestedBranch = normalizeString(body.default_branch ?? body.defaultBranch);
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath) ?? 'kortix.yaml';

  let imported: Awaited<ReturnType<typeof resolveGitHubImport>>;
  try {
    imported = await resolveGitHubImport({
      accountId: scope.accountId,
      repoUrl,
      installationId: normalizeString(body.installation_id ?? body.installationId),
      defaultBranch: requestedBranch,
    });
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: await createGitHubInstallationInstallUrl(error.accountId, scope.userId),
      }, 409);
    }
    return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
  }

  const row = await registerGitHubLinkedProject({
    accountId: scope.accountId,
    userId: scope.userId,
    repo: imported.repo,
    installation: imported.installation,
    name,
    defaultBranch: imported.defaultBranch,
    manifestPath,
  });
  setContextField('projectId', row.projectId);

  kickProjectTemplatePrebuilds(
    {
      projectId: row.projectId,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: imported.auth.token,
    },
    { accountId: scope.accountId, source: 'project-create' },
  );

  return c.json(serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }), 201);
},
);

// GET /v1/projects/managed-git/status
// Lets the frontend pre-check whether the managed-git "Create project" path
// (POST /provision) is usable BEFORE the user hits its 503, so the create UI
// can disable/annotate that option instead of surfacing a raw server error.
// Self-host deployments with no MANAGED_GIT_* configured are the primary
// case — the BYO-repo import path (POST / and /create-repo) stays available
// regardless.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/managed-git/status',
    tags: ['projects'],
    summary: 'GET /managed-git/status',
    ...auth,
    responses: {
      200: json(
        z.object({ configured: z.boolean(), provider: z.string() }),
        'Whether the managed-git provider is configured on this server',
      ),
    },
  }),
  async (c: any) => {
    const provider = process.env.MANAGED_GIT_PROVIDER?.trim() || 'github';
    const configured = hasBackend(provider) && (await getBackend(provider).isConfigured());
    return c.json({ configured, provider });
  },
);

// POST /v1/projects/provision
// Managed-git "Create project": provisions a repo on the managed backend +
// scoped per-project push token, optionally seeds the starter (web flow), and
// registers the project.
// Used by the web "Create project" button and `kortix ship` when a working tree
// has no `origin` remote. BYO-repo projects go through POST / and /create-repo.
//
// The actual create logic lives in `../provision-core.ts`'s `runProvision`,
// shared with the streaming variant of this route — see that file for the
// idempotency lookup, the quota check, the unique-index-loser rollback, and
// the seed rollback. This handler only resolves the request scope, gates it
// on PROJECT_CREATE, and turns the result into a single JSON response.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/provision',
    tags: ['projects'],
    summary: 'POST /provision',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(400, 403, 409, 502, 503),
    },
  }),
  async (c: any) => {
  const ctx = await buildProvisionContext(c);
  if (!(await authorize(await actorOf(c, ctx.scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE)).allowed) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const result = await runProvision(ctx, () => {
    // The JSON route reports one outcome, not progress. Phases are dropped
    // here on purpose — /provision's response shape is depended on by the CLI
    // (`kortix ship`) and the SDK and must not change.
  });
  return c.json(result.body, result.status, result.headers);
},
);

// POST /v1/projects/provision-stream
// Same create as POST /provision, but reports which phase it is in over
// Server-Sent Events instead of returning a single response at the end.
//
// A SECOND ROUTE rather than a changed one: /provision's single-201 shape is
// depended on by the CLI (`kortix ship`) and the SDK's provisionProject. Both
// routes call the SAME `runProvision` — there is exactly one implementation
// of "create a repo, insert a row, seed it, roll back on failure", and there
// must stay exactly one. Two copies diverge, and the copy that diverges is
// the one that leaves an orphaned managed repo behind.
//
// Framing is a raw Response + ReadableStream — this codebase's one SSE
// pattern (see tunnel/routes/permission-requests.ts's GET /stream), not
// `hono/streaming`'s `streamSSE`, which nothing else in apps/api uses.
// Unlike that tunnel stream, frames here carry NO `event:` line — see the
// `write` comment below for why.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/provision-stream',
    tags: ['projects'],
    summary: 'POST /provision-stream',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: {
          description:
            'A text/event-stream of provision phases, always ending in a terminal ' +
            '`done` or `error` frame — never a bare close.',
          content: { 'text/event-stream': { schema: z.any() } },
        },
        ...errors(403),
    },
  }),
  async (c: any) => {
  const ctx = await buildProvisionContext(c);
  // Same gate as POST /provision, and it MUST run before the stream opens. An
  // unauthorized caller gets a normal JSON 403 — never a 200 SSE stream that
  // then carries an error frame; a 200 status has to mean "authorized", or
  // clients learn to keep reading a 200 body to find out whether they were.
  if (!(await authorize(await actorOf(c, ctx.scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE)).allowed) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        // Data-only framing: `data: <json>\n\n`, no `event:` line. Every
        // payload already carries a `type` field ('phase' | 'done' |
        // 'error') — a discriminated union the SDK switches on. Adding an
        // `event:` name would duplicate that discriminator in two places
        // that can drift out of sync with each other. Do not "fix" this by
        // adding one back.
        const write = (data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // The client disconnected. Provisioning has no AbortSignal (see
            // ProvisionContext in ../provision-core.ts) and keeps running to
            // completion regardless — cancelling between backend.createRepo
            // and the DB insert is exactly how an upstream repo gets
            // orphaned, so a lost reader must not cancel it.
          }
        };

        try {
          const result = await runProvision(ctx, (phase) => write({ type: 'phase', phase }));
          if (result.status === 201) {
            write({ type: 'done', project: result.body });
          } else {
            // `status` alongside the body's `error`/`code` — see
            // `ProvisionStreamEvent`'s doc comment in the SDK
            // (`packages/sdk/src/core/rest/projects-client/projects.ts`).
            // Spread first, explicit field last: `result.body` never carries
            // a `status` key today, but this ordering means it never could
            // silently shadow the real one if that changed.
            write({ type: 'error', ...(result.body as object), status: result.status });
          }
        } catch (error) {
          // The stream must never end in a bare close — that would hand the
          // client an undefined project id. This catch is what guarantees a
          // terminal frame even when runProvision THROWS instead of
          // returning an error result.
          write({ type: 'error', error: (error as Error).message || 'Failed to provision project' });
        } finally {
          try { controller.close(); } catch {}
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    },
  ) as any;
},
);
