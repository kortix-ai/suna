import { ACCOUNT_ACTIONS, assertAuthorized, authorize, listAccessibleResources } from '../../iam';
import { deriveRequestContext } from '../../iam/cache';
import { supabaseAuth } from '../../middleware/auth';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { kickProjectTemplatePrebuilds } from '../../snapshots/builder';
import { kickProjectWarmBake } from '../../snapshots/warm-project';
import { isAccountManager, type ProjectRole } from '../access';
import { getBackend, hasBackend, type GitScope } from '../git-backends';
import { seedRepoViaGitPush } from '../git-backends/seed';
import { createRepo, getGitHubAppInstallation, listInstallationRepositories, verifyGitHubAppInstallStatePayload } from '../github';
import { getProjectSecretValue } from '../secrets';
import { buildStarterFiles, normalizeStarterTemplateId } from '../starter';
import { loadProjectTriggers } from '../triggers';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGithubInstallations, projectMembers, projects } from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { enforceProjectQuota, grantProjectRole, loadProjectForUser, resolveProjectAccount } from '../lib/access';
import { AnyObject, ProjectSchema, projectWebhooksApp, projectsApp } from '../lib/app';
import { GitHubInstallationRequiredError, buildConnectionRef, consumeGitHubInstallationState, createGitHubInstallationInstallUrl, getAccountGitHubInstallation, getProjectGitConnection, getProjectGitRemote, listAccountGitHubInstallations, registerGitHubLinkedProject, resolveGitHubImport, resolveProjectGitAuth, resolveProjectUpstream, upsertProjectGitConnection, withProjectGitAuth } from '../lib/git';
import { UUID_V4_REGEX, deriveProjectName, normalizeRepoUrl, normalizeString, readBody, requestAuditContext, serializeGitHubInstallation, serializeGitHubInstallations, serializeGitHubRepo, serializeProject } from '../lib/serializers';
import { extractWebhookToken, fireGitTrigger, markGitTriggerFired, renderPromptTemplate, verifyWebhookSignature, verifyWebhookToken, webhookPayload } from '../lib/triggers';

projectsApp.use('/*', supabaseAuth);


projectWebhooksApp.post('/projects/:projectId/:slug', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  if (!UUID_V4_REGEX.test(projectId)) return c.json({ error: 'Invalid project id' }, 400);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return c.json({ error: 'Invalid trigger slug' }, 400);
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(and(
      eq(projects.projectId, projectId),
      eq(projects.status, 'active'),
    ))
    .limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  const { specs } = await loadProjectTriggers(await withProjectGitAuth(project));
  const spec = specs.find((s) => s.slug === slug);
  if (!spec || spec.type !== 'webhook' || !spec.enabled) {
    return c.json({ error: 'Not found' }, 404);
  }

  const rawBody = await c.req.text();
  const secret = spec.secretEnv
    ? await getProjectSecretValue(project.projectId, spec.secretEnv)
    : null;
  if (!secret) {
    return c.json({ error: 'Webhook secret is not configured' }, 409);
  }

  // Primary auth: HMAC-SHA256 signature over the raw body (GitHub-compatible).
  // Fallback, ONLY when no signature header is present: a static shared token in
  // X-Kortix-Token or Authorization, for sources that can't HMAC-sign their body
  // (e.g. Better Stack error webhooks — custom headers / basic auth only). Both
  // paths require knowing the trigger's secret, so security is equivalent to a
  // shared bearer token; signed senders are unaffected.
  const signatureHeader =
    c.req.header('x-kortix-signature') || c.req.header('x-hub-signature-256') || null;
  const authed = signatureHeader
    ? verifyWebhookSignature(rawBody, secret, signatureHeader)
    : verifyWebhookToken(
        extractWebhookToken(c.req.header('x-kortix-token'), c.req.header('authorization')),
        secret,
      );
  if (!authed) {
    return c.json({ error: 'Invalid webhook signature' }, 401);
  }

  (c as any).set('accountId', project.accountId);

  const payload = {
    ...webhookPayload(c, rawBody),
    trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
    fired_at: new Date().toISOString(),
  };
  const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);

  const result = await fireGitTrigger({
    spec,
    project,
    payload,
    renderedPrompt,
    source: 'webhook',
    request: requestAuditContext(c),
  });

  if (result.status === 'queued') {
    return c.json({ status: 'queued', reason: result.reason ?? null }, 202);
  }
  if (result.status === 'failed') {
    return c.json({ error: result.error ?? 'Failed to fire trigger' }, 500);
  }
  // Stamp runtime last_fired_at so the UI's "last fired N ago" matches the
  // cron-fire path even when the webhook is the actual source.
  await markGitTriggerFired(project.projectId, spec.slug, new Date());
  return c.json({ status: 'fired', session_id: result.sessionId ?? null }, 202);
});


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
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  // Reach through `any` for non-typed context keys set by the auth
  // middleware (the AppEnv only types userId/userEmail).
  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as
      | string
      | undefined) ?? undefined;
  const requestCtx = deriveRequestContext(c);

  // Ask the IAM engine which projects the caller can READ. V2 returns
  // one of: { mode: 'all' } | { mode: 'none' } | { mode: 'allow_only' }.
  // 'all' = account admin/owner (manager on every project); 'allow_only'
  // = enumerated project IDs from direct project_members + group grants;
  // 'none' = no access.
  const accessible = await listAccessibleResources(
    scope.userId,
    scope.accountId,
    'project.read',
    'project',
    actingTokenId,
    requestCtx,
  );

  if (accessible.mode === 'none') return c.json([]);

  // Build the project rows + per-row project_members metadata used by
  // the UI to label effective_role. We still consult project_members
  // because the IAM engine bridges it into authorize() but doesn't
  // hand the per-row role back here — and the UI wants the original
  // manager/editor/viewer label, not just "allowed".
  const grants = await db
    .select({ projectId: projectMembers.projectId, projectRole: projectMembers.projectRole })
    .from(projectMembers)
    .where(and(
      eq(projectMembers.accountId, scope.accountId),
      eq(projectMembers.userId, scope.userId),
    ));
  const roleByProject = new Map(
    grants.map((g) => [g.projectId, g.projectRole as ProjectRole]),
  );

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
  //   - otherwise → 'viewer' (engine allowed read but we don't know the
  //     exact role; safe minimum for UI affordances)
  const accountManager = isAccountManager(scope.accountRole);
  return c.json(
    rows.map((row) => {
      const projectRole = roleByProject.get(row.projectId) ?? null;
      const effectiveRole = accountManager
        ? 'manager'
        : projectRole ?? 'viewer';
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
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  // IAM-gated. Engine consults super-admin bypass, direct + group
  // policies, and legacy owner/admin bridges (in non-strict mode).
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  let repoUrl: string | null;
  try {
    repoUrl = normalizeRepoUrl(body.repo_url ?? body.repoUrl);
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Invalid repo_url' }, 400);
  }
  if (!repoUrl) {
    return c.json({ error: 'repo_url is required' }, 400);
  }

  const name = normalizeString(body.name) ?? deriveProjectName(repoUrl);
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch) ?? 'main';
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath) ?? 'kortix.toml';

  let imported: Awaited<ReturnType<typeof resolveGitHubImport>>;
  try {
    imported = await resolveGitHubImport({
      accountId: scope.accountId,
      repoUrl,
      installationId: normalizeString(body.installation_id ?? body.installationId),
      defaultBranch,
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

  const quota = await enforceProjectQuota(c, scope.accountId, { repoUrl: imported.repo.clone_url });
  if (quota) return quota;

  const row = await registerGitHubLinkedProject({
    accountId: scope.accountId,
    userId: scope.userId,
    repo: imported.repo,
    installation: imported.installation,
    name,
    defaultBranch: imported.defaultBranch,
    manifestPath,
  });

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

  // Bake the project's warm snapshot (repo pre-cloned at tip + warm opencode
  // caches) so even the FIRST session skips the clone. No-op unless warm
  // snapshots are enabled.
  kickProjectWarmBake(row);

  return c.json(serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }), 201);
},
);

// POST /v1/projects/provision
// Managed-git "Create project": provisions a repo on the managed backend +
// scoped per-project push token, optionally seeds the starter (web flow), and
// registers the project.
// Used by the web "Create project" button and `kortix ship` when a working tree
// has no `origin` remote. BYO-repo projects go through POST / and /create-repo.

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
        ...errors(400, 403, 502, 503),
    },
  }),
  async (c: any) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  if (!(await authorize(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE)).allowed) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  // Managed-git provider, provider-agnostic via the backend registry. GitHub is
  // the default + only active managed backend. Forgejo / Artifacts slot in here
  // as drop-ins.
  const provider =
    normalizeString(body.provider) ??
    (process.env.MANAGED_GIT_PROVIDER?.trim() || 'github');
  if (!hasBackend(provider)) {
    return c.json({ error: `Unsupported managed git provider "${provider}"` }, 400);
  }
  const backend = getBackend(provider);
  if (!(await backend.isConfigured())) {
    return c.json(
      { error: `Managed git provider "${provider}" is not configured on this server` },
      503,
    );
  }

  const name = normalizeString(body.name) ?? normalizeString(body.project_name ?? body.projectName);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!/^[a-zA-Z0-9._ -]+$/.test(name)) {
    return c.json(
      { error: 'name must contain only letters, numbers, spaces, hyphens, underscores or dots' },
      400,
    );
  }
  // Managed repo name = a readable slug from the display name + the project's
  // UUID, so managed repos under the shared org NEVER collide (two projects can
  // share a name). We generate the project id up front to bake it into the repo
  // name and reuse it as the project row id.
  const projectId = randomUUID();
  const baseSlug = (
    name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') ||
    'kortix-project'
  ).slice(0, 40);
  const repoSlug = `${baseSlug}-${projectId}`;
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch) ?? 'main';

  // Provision always mints a brand-new managed repo, so the quota check is a
  // straight count — no repoUrl to treat as an idempotent re-link. Runs after
  // request validation but before we create anything upstream.
  const provisionQuota = await enforceProjectQuota(c, scope.accountId);
  if (provisionQuota) return provisionQuota;

  let provisioned: Awaited<ReturnType<typeof backend.createRepo>>;
  try {
    provisioned = await backend.createRepo({
      accountId: scope.accountId,
      projectId,
      slug: repoSlug,
      defaultBranch,
      isPrivate: true,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Failed to provision managed repo' }, 502);
  }

  const authMethod = provider === 'github' ? 'github_app' : 'managed';
  const now = new Date();
  const [row] = await db
    .insert(projects)
    .values({
      projectId,
      accountId: scope.accountId,
      name,
      repoUrl: provisioned.upstreamUrl,
      defaultBranch: provisioned.defaultBranch,
      manifestPath: 'kortix.toml',
      status: 'active',
      metadata: {
        git: {
          url: provisioned.upstreamUrl,
          upstream_url: provisioned.upstreamUrl,
          default_branch: provisioned.defaultBranch,
          provider,
          managed: true,
          auth: {
            method: authMethod,
            ref: provisioned.credentialRef,
            installation_id: provisioned.installationId,
          },
          repo_id: provisioned.externalRepoId,
          owner: provisioned.repoOwner,
          name: provisioned.repoName,
        },
      },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projects.accountId, projects.repoUrl],
      set: { name, defaultBranch: provisioned.defaultBranch, status: 'active', updatedAt: now },
    })
    .returning();

  await grantProjectRole({
    accountId: scope.accountId,
    projectId: row.projectId,
    userId: scope.userId,
    role: 'manager',
    grantedBy: scope.userId,
  });
  await upsertProjectGitConnection({
    accountId: scope.accountId,
    projectId: row.projectId,
    provider,
    repoUrl: provisioned.upstreamUrl,
    upstreamUrl: provisioned.upstreamUrl,
    managed: true,
    repoOwner: provisioned.repoOwner,
    repoName: provisioned.repoName,
    externalRepoId: provisioned.externalRepoId,
    defaultBranch: provisioned.defaultBranch,
    authMethod,
    installationId: provisioned.installationId,
    credentialRef: provisioned.credentialRef,
    visibility: 'private',
    status: 'connected',
    metadata: { seeded: false },
  });

  // Resolve a push credential for seeding / the CLI's first push. The managed
  // GitHub backend mints an installation token.
  let pushToken = provisioned.initialToken;
  if (!pushToken) {
    pushToken = (await resolveProjectGitAuth(row)).auth?.token ?? null;
  }

  // Seed the starter into the empty repo when the caller has no local working
  // tree to push (web "Create project"). The CLI leaves this false and pushes
  // its own files on first `kortix ship`. If seeding fails we roll back the
  // orphan repo + project so we never leave a half-created project behind.
  const seedStarter = body.seed_starter === true || body.seedStarter === true;
  const starterTemplate = normalizeStarterTemplateId(body.starter_template ?? body.starterTemplate);
  let seeded = false;
  if (seedStarter) {
    const connRef = buildConnectionRef(row, getProjectGitRemote(row, await getProjectGitConnection(row.projectId)));
    try {
      if (!pushToken) throw new Error('no push credential resolved for seeding');
      const starter = buildStarterFiles({ projectName: name, repoFullName: repoSlug, template: starterTemplate });
      if (backend.seedFiles) {
        await backend.seedFiles(connRef, pushToken, starter, {
          branch: provisioned.defaultBranch,
          message: 'chore: scaffold Kortix project',
        });
      } else {
        await seedRepoViaGitPush({
          upstreamUrl: connRef.upstreamUrl,
          token: pushToken,
          files: starter,
          branch: provisioned.defaultBranch,
          commitMessage: 'chore: scaffold Kortix project',
        });
      }
      seeded = true;
    } catch (error) {
      try { await backend.deleteRepo(connRef); } catch { /* best effort */ }
      await db.delete(projects).where(eq(projects.projectId, row.projectId)).catch(() => {});
      return c.json({ error: (error as Error).message || 'Failed to seed project repo' }, 502);
    }
  }

  if (seeded) {
    kickProjectTemplatePrebuilds(
      {
        projectId: row.projectId,
        repoUrl: row.repoUrl,
        defaultBranch: row.defaultBranch,
        manifestPath: row.manifestPath,
        gitAuthToken: pushToken,
      },
      { accountId: scope.accountId, source: 'project-create' },
    );
  }

  return c.json(
    {
      ...serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }),
      push_token: pushToken,
      repo_id: provisioned.externalRepoId,
      seeded,
    },
    201,
  );
},
);

// POST /v1/projects/:projectId/git-token
// Mint a fresh scoped push token for a *managed* project so the CLI
// can push on a later `kortix ship` without persisting credentials in git config.
// Returns 409 for BYO projects (they push with the user's own git remote auth).

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/git-token',
    tags: ['github'],
    summary: 'POST /:projectId/git-token',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409, 503),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const connection = await getProjectGitConnection(projectId);
  const remote = getProjectGitRemote(loaded.row, connection);
  if (!remote.managed) {
    return c.json({ error: 'Project is not a managed repo' }, 409);
  }

  // Provider-agnostic: resolve a fresh push credential through the backend seam
  // (the managed GitHub backend mints an installation token). Never persisted
  // in the sandbox/CLI git config.
  const gitAuth = await resolveProjectGitAuth(loaded.row);
  if (!gitAuth.auth?.token) {
    return c.json({ error: 'Managed git is not configured / unavailable for this project' }, 503);
  }
  const upstream = await resolveProjectUpstream(loaded.row, 'write');

  return c.json({
    push_token: gitAuth.auth.token,
    repo_id: remote.externalRepoId,
    repo_url: upstream?.url ?? loaded.row.repoUrl,
  });
},
);

// POST /v1/projects/:projectId/git/collaborators
// Invite a GitHub user as a collaborator on a MANAGED repo — lets the project
// creator pull "their" Kortix-managed repo into their own GitHub account and
// work on it on github.com directly. Managed repos only (the user already owns
// BYO repos). GitHub sends a pending invite the user accepts.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/git/collaborators',
    tags: ['github'],
    summary: 'POST /:projectId/git/collaborators',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 409, 502),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const username = normalizeString(body.github_username ?? body.username ?? body.login);
  if (!username) return c.json({ error: 'github_username is required' }, 400);
  const permission = normalizeString(body.permission);
  const scope: GitScope = permission === 'read' || permission === 'pull' ? 'read' : 'write';

  const remote = getProjectGitRemote(loaded.row, await getProjectGitConnection(projectId));
  if (remote.provider !== 'github' || !remote.managed) {
    return c.json({ error: 'Collaborator invites are only available for managed GitHub repos' }, 409);
  }
  const ref = buildConnectionRef(loaded.row, remote);
  const backend = getBackend(remote.provider);
  if (!backend.inviteCollaborator) {
    return c.json({ error: 'This git backend does not support collaborator invites' }, 400);
  }

  try {
    const result = await backend.inviteCollaborator(ref, username, scope);
    return c.json(result);
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Failed to invite collaborator' }, 502);
  }
},
);

// GET /v1/projects/github/installation?account_id=...
// Account-scoped GitHub App install state. The client only receives metadata;
// installation tokens are minted server-side at repo creation time.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/installation',
    tags: ['github'],
    summary: 'GET /github/installation',
    ...auth,
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const rows = await listAccountGitHubInstallations(scope.accountId);
  const canManageGit = (await authorize(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed;
  const installUrl = canManageGit
    ? await createGitHubInstallationInstallUrl(scope.accountId, scope.userId)
    : null;
  return c.json(serializeGitHubInstallations(rows, scope.accountId, installUrl));
},
);

// GET /v1/projects/github/installations?account_id=...
// Vercel-style account Git connections surface. A Kortix account can connect
// multiple GitHub users/orgs and pick the exact installation during import.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/installations',
    tags: ['github'],
    summary: 'GET /github/installations',
    ...auth,
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const rows = await listAccountGitHubInstallations(scope.accountId);
  const canManageGit = (await authorize(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed;
  const installUrl = canManageGit
    ? await createGitHubInstallationInstallUrl(scope.accountId, scope.userId)
    : null;
  return c.json(serializeGitHubInstallations(rows, scope.accountId, installUrl));
},
);

// POST /v1/projects/github/installation
// Called after GitHub redirects back with installation_id + signed state.
// We fetch installation metadata with the app JWT instead of trusting client
// supplied owner information.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/github/installation',
    tags: ['github'],
    summary: 'POST /github/installation',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 502),
    },
  }),
  async (c: any) => {
  const body = await readBody(c);
  const state = normalizeString(body.state);
  if (!state) return c.json({ error: 'state is required' }, 400);
  const statePayload = verifyGitHubAppInstallStatePayload(state);
  if (!statePayload?.accountId || !statePayload.nonce) {
    return c.json({ error: 'invalid GitHub installation state' }, 400);
  }

  const scope = await resolveProjectAccount(c, { account_id: statePayload.accountId });
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const installationId = normalizeString(body.installation_id ?? body.installationId);
  if (!installationId) return c.json({ error: 'installation_id is required' }, 400);
  if (!/^[0-9]+$/.test(installationId)) {
    return c.json({ error: 'installation_id must be a GitHub installation id' }, 400);
  }

  const stateStatus = await consumeGitHubInstallationState({
    accountId: scope.accountId,
    userId: scope.userId,
    nonce: statePayload.nonce,
    installationId,
  });
  if (stateStatus === 'invalid') {
    const existing = await getAccountGitHubInstallation(scope.accountId, installationId);
    if (existing?.installationId === installationId) {
      return c.json(serializeGitHubInstallation(existing, scope.accountId, null), 200);
    }
    return c.json({ error: 'GitHub installation state is expired or already used' }, 400);
  }

  let installation;
  try {
    installation = await getGitHubAppInstallation(installationId);
  } catch (error) {
    const message = (error as Error).message || 'Failed to verify GitHub App installation';
    return c.json({ error: message }, 502);
  }

  const ownerLogin = normalizeString(installation.account?.login);
  if (!ownerLogin) {
    return c.json({ error: 'GitHub installation did not include an owner account' }, 502);
  }

  const now = new Date();
  const [row] = await db
    .insert(accountGithubInstallations)
    .values({
      accountId: scope.accountId,
      installationId,
      ownerLogin,
      ownerType: normalizeString(installation.account?.type) ?? installation.target_type ?? 'Organization',
      repositorySelection: installation.repository_selection ?? null,
      permissions: installation.permissions ?? {},
      metadata: {
        html_url: installation.html_url ?? null,
      },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [accountGithubInstallations.accountId, accountGithubInstallations.installationId],
      set: {
        ownerLogin,
        ownerType: normalizeString(installation.account?.type) ?? installation.target_type ?? 'Organization',
        repositorySelection: installation.repository_selection ?? null,
        permissions: installation.permissions ?? {},
        metadata: {
          html_url: installation.html_url ?? null,
        },
        updatedAt: now,
      },
    })
    .returning();

  return c.json(serializeGitHubInstallation(row, scope.accountId, null), 200);
},
);

// DELETE /v1/projects/github/installation?account_id=...

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/github/installation',
    tags: ['github'],
    summary: 'DELETE /github/installation',
    ...auth,
      request: {
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const installationId = normalizeString(c.req.query('installation_id') ?? c.req.query('installationId'));

  await db
    .delete(accountGithubInstallations)
    .where(installationId
      ? and(
          eq(accountGithubInstallations.accountId, scope.accountId),
          eq(accountGithubInstallations.installationId, installationId),
        )
      : eq(accountGithubInstallations.accountId, scope.accountId));

  return c.json({ ok: true });
},
);

// DELETE /v1/projects/github/installations/:installationId?account_id=...

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/github/installations/{installationId}',
    tags: ['github'],
    summary: 'DELETE /github/installations/:installationId',
    ...auth,
      request: {
        params: z.object({ installationId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const installationId = c.req.param('installationId');

  await db
    .delete(accountGithubInstallations)
    .where(and(
      eq(accountGithubInstallations.accountId, scope.accountId),
      eq(accountGithubInstallations.installationId, installationId),
    ));

  return c.json({ ok: true });
},
);

// GET /v1/projects/github/repositories?account_id=...
// Vercel-style import surface: list repos available to the account's GitHub App
// installation without exposing an installation token to the browser.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/repositories',
    tags: ['github'],
    summary: 'GET /github/repositories',
    ...auth,
      request: {
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(409, 502),
    },
  }),
  async (c: any) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const installationId = normalizeString(c.req.query('installation_id') ?? c.req.query('installationId'));
  const installation = await getAccountGitHubInstallation(scope.accountId, installationId);
  if (!installation) {
    return c.json({
      error: installationId
        ? 'Selected GitHub installation is not connected to this account'
        : 'Install the Kortix GitHub App before importing repositories',
      install_url: await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
    }, 409);
  }

  try {
    const repos = await listInstallationRepositories(installation.installationId);
    return c.json({
      account_id: scope.accountId,
      installation_id: installation.installationId,
      owner_login: installation.ownerLogin,
      repositories: repos.map(serializeGitHubRepo),
    });
  } catch (error) {
    const message = (error as Error).message || 'Failed to list GitHub repositories';
    return c.json({ error: message }, 502);
  }
},
);

// POST /v1/projects/link-repository
// Import an existing GitHub repo through the account GitHub App installation.
// This validates repo access up front and stores a typed project_git_connection.
