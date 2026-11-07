/**
 * Projects: list, create, managed-git status, and provision. Imported first by
 * ../index.ts: its first statement registers the global `/*` auth middleware.
 */
import { projectRoleGrants } from '../../iam/read-models';
import { ACCOUNT_ACTIONS, assertAuthorized, authorize, listAccessible } from '../../iam';
import { actorOf } from '../../iam/actor';
import { setContextField } from '../../lib/request-context';
import { supabaseAuth } from '../../middleware/auth';
import { auth, errors, json, lenientBody } from '../../openapi';
import { db } from '../../shared/db';
import { kickProjectTemplatePrebuilds } from '../../snapshots/builder';
import { isAccountManager } from '../access';
import { getBackend, hasBackend } from '../git-backends';
import {
  buildNewWorkspaceProvisionContext,
  runProvision,
  type ProvisionContext,
  type ProvisionResult,
} from '../provision-core';
import { newWorkspaceCallerDenial, wantsNewWorkspace } from '../new-workspace';
import { newWorkspaceCallerOf } from '../lib/new-workspace-caller';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { enforceProjectQuota, resolveProjectAccount } from '../lib/access';
import { projectQuotaState } from '../lib/project-quota';
import { ProjectSchema, projectsApp } from '../lib/app';
import {
  GitHubInstallationRequiredError,
  createGitHubInstallationInstallUrl,
  resolveGitHubImport,
} from '../lib/git';
import { registerGitHubLinkedProject } from '../lib/project-registration';
import { createByoWorkspaceAccount, resolveByoCreateScope, resolveByoCreateTarget } from './byo-new-workspace';
import {
  deriveProjectName,
  normalizeRepoUrl,
  normalizeString,
  serializeProject,
} from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import { rethrowDatabaseError } from '../../shared/database-errors';
import { isNoWorkspaceError } from '../../shared/no-workspace';
import { accountTakenForNewProject, workspaceHasProjectDenial } from '../../workspaces/one-project';
import { projectsView } from '../../workspaces/rows';

/**
 * Reads the request body and resolves the caller's account scope — the part
 * of the old `POST /provision` handler that runs BEFORE the
 * `PROJECT_CREATE` authorization check. Kept out of `runProvision` itself so
 * a caller (either route) can still 403 before any provisioning work starts.
 */
async function buildProvisionContext(c: Context): Promise<{ result: ProvisionResult } | { ctx: ProvisionContext }> {
  let body = await readJsonObject(c);
  const caller = newWorkspaceCallerOf(c);
  const newWorkspace = async () => {
    const built = await buildNewWorkspaceProvisionContext(body, caller);
    if ('ctx' in built) c.set('accountId', built.ctx.scope.accountId);
    return built;
  };
  // `new_workspace: true`: the server picks or creates the account
  // (../new-workspace.ts). The caller sends no account_id.
  if (wantsNewWorkspace(body)) return newWorkspace();

  // Compatibility: every client before Workspaces 1:1 always created a project
  // with this route, and it still does. A request that names no account (cached
  // web and mobile bundles, the SDK's provisionProject) becomes a new workspace
  // when the caller's active account already holds its one project, or when the
  // caller has no workspace yet. A request that names an occupied account (the
  // published CLI <= 0.14 sends `account_id` in the body and the query on
  // `kortix projects create` and `kortix ship`) becomes a new workspace too,
  // when the caller is a person who may create a project in that account. An
  // API key, a scoped token or an impersonating operator keeps the 409
  // workspace_has_project. POST /v1/workspaces never reaches this route.
  const namesAccount = Boolean(
    normalizeString(c.req.query('account_id') ?? c.req.query('accountId') ?? body.account_id ?? body.accountId),
  );
  const person = newWorkspaceCallerDenial(caller) === null;
  let scope: Awaited<ReturnType<typeof resolveProjectAccount>>;
  try {
    scope = await resolveProjectAccount(c, body);
  } catch (err) {
    if (person && !namesAccount && isNoWorkspaceError(err)) return newWorkspace();
    throw err;
  }
  if (!person) return { ctx: { body, scope } };
  const idempotencyKey = normalizeString(body.idempotency_key ?? body.idempotencyKey) ?? null;
  if (!(await accountTakenForNewProject(scope.accountId, idempotencyKey))) return { ctx: { body, scope } };
  if (!namesAccount) return newWorkspace();
  // The named account must be one the person may create in: without that the
  // request keeps its old 403, and never turns into a workspace elsewhere.
  if (!(await authorize(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE)).allowed) {
    return { ctx: { body, scope } };
  }
  const { account_id: _a, accountId: _b, ...rest } = body;
  body = rest;
  return newWorkspace();
}

/** `new_workspace` on the two provision routes. */
const NEW_WORKSPACE_FIELD = z.boolean().optional().openapi({
  description:
    'Create a whole workspace: the server creates a new account named after the project (a retry with the same idempotency_key returns the first one), then provisions into it. Excludes account_id (400 new_workspace_with_account_id). 403 account_creation_restricted where the deployment restricts account creation.',
});

export function registerProjectsRoutes(): void {
  projectsApp.use('/*', supabaseAuth);

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['projects'],
      summary: 'List projects',
      ...auth,
      responses: {
          200: json(z.array(ProjectSchema), 'Projects the caller can read'),
      },
    }),
    async (c) => {
    // A person with no workspace has no projects. The list is `[]`, like
    // GET /v1/accounts, never a 409: the switcher reads it on every page.
    let scope: Awaited<ReturnType<typeof resolveProjectAccount>>;
    try {
      scope = await resolveProjectAccount(c);
    } catch (err) {
      if (isNoWorkspaceError(err) && !c.req.query('account_id') && !c.req.query('accountId')) return c.json([]);
      throw err;
    }
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
    // verdict above came from. Neither this read nor the row read needs the
    // other, so they run together.
    const baseWhere = and(
      eq(projectsView.accountId, scope.accountId),
      eq(projectsView.status, 'active'),
    );

    // mode === 'allow_only' with nothing enumerated. The 'none' case was
    // returned above.
    if (accessible.mode !== 'all' && accessible.allowed.size === 0) return c.json([]);
    const [grants, rows] = await Promise.all([
      projectRoleGrants({ accountId: scope.accountId, userId: scope.userId }),
      db
        .select()
        .from(projectsView)
        .where(
          accessible.mode === 'all'
            ? baseWhere
            : and(baseWhere, inArray(projectsView.projectId, [...accessible.allowed])),
        )
        .orderBy(desc(projectsView.updatedAt)),
    ]);
    const roleByProject = new Map(grants.map((g) => [g.projectId, g.projectRole]));

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
      summary: 'Create a project from an existing GitHub repository',
      description:
        'Import an existing GitHub repository as a project. To create a project with a new repository use POST /v1/projects/provision.',
      ...auth,
        request: {
          body: { content: { 'application/json': { schema: lenientBody({
              repo_url: z.string().openapi({ description: 'https URL of an existing GitHub repository, e.g. https://github.com/org/repo. camelCase repoUrl is also accepted.' }),
              name: z.string().optional().openapi({ description: 'Project name. Defaults to the repository name.' }),
              default_branch: z.string().optional().openapi({ description: 'Branch to track. Defaults to the repository default branch.' }),
              manifest_path: z.string().optional().openapi({ description: 'Manifest path in the repository. Default kortix.yaml.' }),
              installation_id: z.string().optional().openapi({ description: 'GitHub App installation id that can read the repository.' }),
              account_id: z.string().optional().openapi({ description: 'Account to create the project in. Defaults to the caller\'s account.' }),
            }) } } },
        },
      responses: {
          201: json(ProjectSchema, 'The created project'),
          ...errors(400, 403, 409),
      },
    }),
    async (c) => {
    const body = await readJsonObject(c);
    // IAM-gated (`project.create` in the named account). An occupied account
    // turns an old client's request into a new workspace, created after the
    // repository is validated (./byo-new-workspace.ts).
    const byoScope = await resolveByoCreateScope(c, body, { tokenPath: false });

    let repoUrl: string | null;
    try {
      repoUrl = normalizeRepoUrl(body.repo_url ?? body.repoUrl);
    } catch (error) {
      return c.json({ error: (error as Error).message || 'Invalid repo_url' }, 400);
    }
    if (!repoUrl) {
      return c.json({ error: 'repo_url is required' }, 400);
    }

    const placed = await resolveByoCreateTarget(c, byoScope, { tokenPath: false });
    if ('response' in placed) return placed.response as never;
    const { target } = placed;
    // The App path always has a source account (rule 5 of byo-new-workspace.ts).
    const sourceAccountId = target.kind === 'account' ? target.accountId : target.sourceAccountId!;

    const name = normalizeString(body.name) ?? deriveProjectName(repoUrl);
    const requestedBranch = normalizeString(body.default_branch ?? body.defaultBranch);
    const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath) ?? 'kortix.yaml';

    let imported: Awaited<ReturnType<typeof resolveGitHubImport>>;
    try {
      imported = await resolveGitHubImport({
        accountId: sourceAccountId,
        repoUrl,
        installationId: normalizeString(body.installation_id ?? body.installationId),
        defaultBranch: requestedBranch,
      });
    } catch (error) {
      if (error instanceof GitHubInstallationRequiredError) {
        return c.json({
          error: error.message,
          install_url: await createGitHubInstallationInstallUrl(error.accountId, target.userId),
        }, 409);
      }
      rethrowDatabaseError(error);
      return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
    }

    const landed = target.kind === 'account'
      ? { accountId: target.accountId }
      : await createByoWorkspaceAccount(c, name);
    if ('response' in landed) return landed.response as never;
    const row = await registerGitHubLinkedProject({
      accountId: landed.accountId,
      userId: target.userId,
      repo: imported.repo,
      installation: imported.installation,
      // The installation stays linked to the source account: a grant for this repository only.
      projectGrant: target.kind === 'new_workspace',
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
      { accountId: landed.accountId, source: 'project-create' },
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
      summary: 'Get managed Git availability',
      ...auth,
      responses: {
        200: json(
          z.object({ configured: z.boolean(), provider: z.string() }),
          'Whether the managed-git provider is configured on this server',
        ),
      },
    }),
    async (c) => {
      const provider = process.env.MANAGED_GIT_PROVIDER?.trim() || 'github';
      const configured = hasBackend(provider) && (await getBackend(provider).isConfigured());
      return c.json({ configured, provider });
    },
  );

  // GET /v1/projects/quota (legacy name only; not under /v1/workspaces)
  // The create pre-check: whether the account may create its project, from the
  // create gate's own rule (`projectQuotaState`), so the two never disagree.
  // `account_id` resolves through `resolveProjectAccount`; omitted, the default
  // account an omitted-account create would target.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/quota',
      tags: ['projects'],
      summary: 'Get whether an account may create its project',
      description:
        'The workspace rule of the create gate: `limit` is 1 on every plan; `capped` is true when the account already holds its project, and `message` is the create gate text. To make another workspace, use `POST /v1/workspaces`.',
      ...auth,
      responses: {
        200: json(
          z.object({
            capped: z.boolean(),
            limit: z.number(),
            count: z.number().nullable(),
            message: z.string().nullable(),
          }),
          'Whether another project can be created in this account, and why not',
        ),
      },
    }),
    async (c) => {
      const scope = await resolveProjectAccount(c);
      // Membership is a person's gate here. A service account has none, so it
      // reads the create pre-check only when it may create.
      if (c.get('authType') === 'service_account') {
        await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE);
      }
      return c.json(await projectQuotaState(scope.accountId));
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
      summary: 'Create a project with a new managed repository',
      description:
        'Create a project with a new managed repository. Send an Idempotency-Key header to make retries safe.',
      ...auth,
        request: {
          body: { content: { 'application/json': { schema: lenientBody({
              name: z.string().optional().openapi({ description: 'Project name.' }),
              provider: z.string().optional().openapi({ description: 'Managed Git provider. Defaults to the deployment default (github).' }),
              icon: z.string().optional().openapi({ description: 'Project icon name.' }),
              icon_glyph: z.string().optional().openapi({ description: 'Project icon glyph.' }),
              source_item_id: z.string().optional().openapi({ description: 'Marketplace project item id to clone into the new repository.' }),
              starter_template: z.string().optional().openapi({ description: 'Starter template id to seed the repository.' }),
              default_branch: z.string().optional().openapi({ description: 'Default branch. Default main.' }),
              seed_starter: z.boolean().optional().openapi({ description: 'Set false when the client makes the first commit itself.' }),
              marketplace_items: z.array(z.any()).optional().openapi({ description: 'Marketplace items to install into the new project.' }),
              account_id: z.string().optional().openapi({ description: 'Account to create the project in. Defaults to the caller\'s account.' }),
              new_workspace: NEW_WORKSPACE_FIELD,
            }) } } },
        },
      responses: {
          201: json(z.any(), 'OK'),
          ...errors(400, 403, 409, 502, 503),
      },
    }),
    async (c) => {
    const built = await buildProvisionContext(c);
    if ('result' in built) return c.json(built.result.body, built.result.status, built.result.headers);
    const { ctx } = built;
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
  // Framing is a raw Response + ReadableStream, not `hono/streaming`'s
  // `streamSSE`, which nothing else in apps/api uses. Frames carry NO `event:`
  // line — see the `write` comment below for why.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/provision-stream',
      tags: ['projects'],
      summary: 'Create a project with a new managed repository (streamed progress)',
      ...auth,
        request: {
          body: { content: { 'application/json': { schema: lenientBody({
              name: z.string().optional().openapi({ description: 'Project name.' }),
              provider: z.string().optional().openapi({ description: 'Managed Git provider. Defaults to the deployment default (github).' }),
              icon: z.string().optional().openapi({ description: 'Project icon name.' }),
              icon_glyph: z.string().optional().openapi({ description: 'Project icon glyph.' }),
              source_item_id: z.string().optional().openapi({ description: 'Marketplace project item id to clone into the new repository.' }),
              starter_template: z.string().optional().openapi({ description: 'Starter template id to seed the repository.' }),
              default_branch: z.string().optional().openapi({ description: 'Default branch. Default main.' }),
              seed_starter: z.boolean().optional().openapi({ description: 'Set false when the client makes the first commit itself.' }),
              marketplace_items: z.array(z.any()).optional().openapi({ description: 'Marketplace items to install into the new project.' }),
              account_id: z.string().optional().openapi({ description: 'Account to create the project in. Defaults to the caller\'s account.' }),
              new_workspace: NEW_WORKSPACE_FIELD,
            }) } } },
        },
      responses: {
          200: {
            description:
              'A text/event-stream of provision phases, always ending in a terminal ' +
              '`done` or `error` frame — never a bare close.',
            content: { 'text/event-stream': { schema: z.any() } },
          },
          ...errors(400, 403, 409, 503),
      },
    }),
    async (c) => {
    const built = await buildProvisionContext(c);
    // A refusal decided before the stream opens (a new workspace's request
    // checks, its account choice) is a plain JSON response, never a 200 SSE.
    if ('result' in built) return c.json(built.result.body, built.result.status as 400 | 403 | 503, built.result.headers);
    const { ctx } = built;
    // Same gate as POST /provision, and it MUST run before the stream opens. An
    // unauthorized caller gets a normal JSON 403 — never a 200 SSE stream that
    // then carries an error frame; a 200 status has to mean "authorized", or
    // clients learn to keep reading a 200 body to find out whether they were.
    if (!(await authorize(await actorOf(c, ctx.scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE)).allowed) {
      return c.json({ error: 'Owner or admin role required' }, 403);
    }
    // Same reason: an account that already holds its one active project
    // (Workspaces 1:1) is a plain JSON 409 `workspace_has_project`, never a 200
    // stream with an error frame. A new workspace picked an empty account.
    // `runProvision` checks again, after the idempotency replay.
    if (!ctx.newWorkspace && !normalizeString(ctx.body.idempotency_key ?? ctx.body.idempotencyKey)) {
      const occupied = await workspaceHasProjectDenial(ctx.scope.accountId);
      if (occupied) return c.json(occupied, 409);
    }

    return provisionStreamResponse(ctx) as any;
  },
  );
}

/**
 * The provision SSE stream: `data: <json>` frames of `phase`, then one
 * terminal `done` or `error`. `done` carries `project`; `done(project)` adds
 * fields to that frame (`POST /v1/workspaces` adds `workspace`). Shared by
 * `POST /v1/projects/provision-stream` and `POST /v1/workspaces` with
 * `Accept: text/event-stream`: one implementation of the create.
 */
export function provisionStreamResponse(
  ctx: ProvisionContext,
  done?: (project: unknown) => Promise<Record<string, unknown>>,
): Response {
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
            write({ type: 'done', project: result.body, ...(await done?.(result.body)) });
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
  );
}
