import { parseSharingIntent, resolveShareSubject, setSecretSharing } from '../../executor/share';
import { auth, errors, json } from '../../openapi';
import { createAccountToken, listAccountTokens, revokeAccountToken } from '../../repositories/account-tokens';
import { db } from '../../shared/db';
import { kickPreBuild } from '../../snapshots/builder';
import { getTemplateById } from '../../snapshots/templates';
import { roleAllows } from '../access';
import { loadProjectConfig } from '../git';
import { completeChatGptHeadlessAuth, startChatGptHeadlessAuth } from '../opencode-chatgpt-auth';
import { encryptProjectSecret, isValidSecretName } from '../secrets';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { createRoute, z } from '@hono/zod-openapi';
import { projectSecrets, projects, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { loadProjectForUser } from '../lib/access';
import { AnyObject, SecretSchema, projectsApp } from '../lib/app';
import { getProjectGitConnection, getProjectGitRemote, hasServerManagedGitAuth, loadGitProject, resolveProjectGitAuth, upsertProjectGitConnection, upsertProjectGitCredential, withProjectGitAuth } from '../lib/git';
import { CODEX_AUTH_JSON_SECRET_NAME, isSystemProjectSecretName, loadSecretViewsForUser, normalizeString, readBody, serializeProjectGitConnection } from '../lib/serializers';

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sandbox-templates/{templateId}/build',
    tags: ['sandboxes'],
    summary: 'POST /:projectId/sandbox-templates/:templateId/build',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), templateId: z.string() }),
      },
    responses: {
        202: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const row = await getTemplateById(templateId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.projectId !== null && row.projectId !== projectId) {
    return c.json({ error: 'Not found' }, 404);
  }

  const project = await loadGitProject(loaded);
  kickPreBuild(project, { slug: row.slug, accountId: loaded.row.accountId, source: 'manual' });
  return c.json({ status: 'started', template_id: row.templateId, slug: row.slug }, 202);
},
);

// ─── Project-scoped CLI tokens ─────────────────────────────────────────────
// These are PATs (`kortix_pat_...`) bound to a single project. The auth
// middleware enforces that the URL's `:projectId` matches the token's
// project_id, so the token is useless outside this one project. They're
// auto-minted at session-create time and injected into the sandbox as
// `KORTIX_TOKEN` so the in-container CLI works with zero config.


projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/cli-token',
    tags: ['projects'],
    summary: 'GET /:projectId/cli-token',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const tokens = await listAccountTokens(loaded.row.accountId, projectId);
  return c.json({
    items: tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
      public_key: t.publicKey,
      status: t.status,
      expires_at: t.expiresAt?.toISOString() ?? null,
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      created_at: t.createdAt.toISOString(),
      revoked_at: t.revokedAt?.toISOString() ?? null,
    })),
  });
},
);


projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/cli-token',
    tags: ['projects'],
    summary: 'POST /:projectId/cli-token',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Authorization is enforced by loadProjectForUser(... 'manage') above,
  // which routes through the IAM engine (project.write).

  // One body field: `name`. Defaults to "cli · <project name>".
  let body: { name?: unknown } = {};
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    /* empty body is fine */
  }
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 255)
      : `cli · ${loaded.row.name}`;

  const userId = c.get('userId') as string;
  const created = await createAccountToken({
    accountId: loaded.row.accountId,
    userId,
    projectId,
    name,
  });

  return c.json(
    {
      token_id: created.tokenId,
      name: created.name,
      public_key: created.publicKey,
      secret_key: created.secretKey,
      status: created.status,
      project_id: created.projectId,
      expires_at: created.expiresAt?.toISOString() ?? null,
      created_at: created.createdAt.toISOString(),
    },
    201,
  );
},
);


projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/cli-token/{tokenId}',
    tags: ['projects'],
    summary: 'DELETE /:projectId/cli-token/:tokenId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), tokenId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const tokenId = c.req.param('tokenId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Authorization is enforced by loadProjectForUser(... 'manage') above.
  const ok = await revokeAccountToken(tokenId, loaded.row.accountId);
  if (!ok) return c.json({ error: 'token not found or already revoked' }, 404);
  return c.json({ ok: true });
},
);

// GET /v1/projects/:projectId/git/clone-credential
// Runtime-only clone credential fetch. A session sandbox calls this endpoint
// with its sandbox-scoped KORTIX_TOKEN and gets a fresh provider credential
// just-in-time. Browser sessions must not receive raw Git tokens.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/git/clone-credential',
    tags: ['github'],
    summary: 'GET /:projectId/git/clone-credential',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(403, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const authType = (c as any).get('authType') as string | undefined;
  const tokenProjectId = (c as any).get('tokenProjectId') as string | undefined;

  let projectRow: typeof projects.$inferSelect | null = null;

  if (authType === 'pat') {
    if (tokenProjectId !== projectId) {
      return c.json({ error: 'clone credentials require a project-scoped runtime token' }, 403);
    }
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    projectRow = loaded.row;
  } else if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
    const accountId = (c as any).get('accountId') as string | undefined;
    const sandboxId = (c as any).get('sandboxId') as string | undefined;
    if (!accountId || !sandboxId) {
      return c.json({ error: 'clone credentials require a sandbox token' }, 403);
    }
    const [sandbox] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ))
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
    }
    const [row] = await db
      .select()
      .from(projects)
      .where(and(
        eq(projects.projectId, projectId),
        eq(projects.accountId, accountId),
      ))
      .limit(1);
    if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
    projectRow = row;
  } else {
    return c.json({ error: 'clone credentials are only available to runtime tokens' }, 403);
  }
  if (!projectRow) return c.json({ error: 'Not found' }, 404);

  const gitAuth = await resolveProjectGitAuth(projectRow);
  if (!gitAuth.auth?.token) {
    return c.json({
      repo_url: projectRow.repoUrl,
      auth: null,
      source: gitAuth.authSource,
    });
  }

  return c.json({
    repo_url: projectRow.repoUrl,
    auth: {
      username: 'x-access-token',
      token: gitAuth.auth.token,
      type: 'basic',
    },
    source: gitAuth.authSource,
    expires_at: null,
  });
},
);

// PUT /v1/projects/:projectId/git-credential
// Stores provider-neutral BYO git credentials as platform credentials, not as
// user-readable/injectable runtime secrets. The managed GitHub backend mints
// credentials server-side; this exists for generic future providers such as
// GitLab/Bitbucket until they have first-class adapters.

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/git-credential',
    tags: ['github'],
    summary: 'PUT /:projectId/git-credential',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (await hasServerManagedGitAuth(loaded.row)) {
    return c.json({ error: 'Git auth is already managed by Kortix for this project' }, 409);
  }

  const token =
    typeof body.token === 'string'
      ? body.token.trim()
      : typeof body.value === 'string'
        ? body.value.trim()
        : '';
  if (!token) return c.json({ error: 'token is required' }, 400);

  const existingConnection = await getProjectGitConnection(projectId);
  const remote = getProjectGitRemote(loaded.row, existingConnection);
  const provider = normalizeString(body.provider) ?? (remote.provider === 'github' ? 'generic' : remote.provider);
  if (provider === 'github') {
    return c.json({ error: 'GitHub credentials are managed through the GitHub App connection' }, 409);
  }

  const credential = await upsertProjectGitCredential({
    accountId: loaded.row.accountId,
    projectId,
    provider,
    token,
    createdBy: loaded.userId,
  });
  const connection = await upsertProjectGitConnection({
    accountId: loaded.row.accountId,
    projectId,
    provider,
    repoUrl: loaded.row.repoUrl,
    defaultBranch: loaded.row.defaultBranch,
    authMethod: 'project_credential',
    credentialRef: credential.credentialId,
    status: 'connected',
    metadata: { credential_kind: 'token' },
  });

  return c.json({
    configured: true,
    provider,
    git_connection: serializeProjectGitConnection(connection),
  }, 200);
},
);

// GET /v1/projects/:projectId/secrets
// Readable by any project member: returns each secret KEY as the per-user view
// (the shared row + that member's own override, names only, no plaintext) plus
// the manifest-declared required/optional env keys. Members manage only their
// own override; managers additionally manage the shared row (`can_manage_shared`).

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/secrets',
    tags: ['secrets'],
    summary: 'GET /:projectId/secrets',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(SecretSchema), 'Secrets'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const subject = await resolveShareSubject(loaded.userId);
  const canManageShared = roleAllows(loaded.effectiveRole, 'manage');

  // Manifest is optional — a project without kortix.toml just gets empty
  // required/optional lists. We surface loaded/missing/error explicitly so the
  // UI can distinguish "no envs declared" from "we couldn't read the manifest".
  let required: string[] = [];
  let optional: string[] = [];
  let manifestStatus: 'loaded' | 'missing' | 'error' = 'missing';
  let manifestError: string | null = null;
  try {
    const projectConfig = await loadProjectConfig(await withProjectGitAuth(loaded.row), []);
    required = projectConfig?.env?.required ?? [];
    optional = projectConfig?.env?.optional ?? [];
    manifestStatus = projectConfig?.manifest_raw ? 'loaded' : 'missing';
  } catch (err) {
    manifestStatus = 'error';
    manifestError = err instanceof Error ? err.message : String(err);
    console.warn('[projects] secrets: manifest load failed', {
      projectId,
      manifestPath: loaded.row.manifestPath,
      error: manifestError,
    });
  }

  const items = (await loadSecretViewsForUser(projectId, subject, canManageShared))
    .filter((item) => !item.system);

  return c.json({
    items,
    required,
    optional,
    // Page-level: may this member edit shared rows (add/set/share), or only
    // manage their own overrides?
    can_manage: canManageShared,
    manifest_status: manifestStatus,
    manifest_path: loaded.row.manifestPath,
    ...(manifestError ? { manifest_error: manifestError } : {}),
  });
},
);

// POST /v1/projects/:projectId/secrets
// Upsert a project secret. The response intentionally omits value/value_enc.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/secrets',
    tags: ['secrets'],
    summary: 'POST /:projectId/secrets',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(SecretSchema, 'The created secret'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const name = normalizeString(body.name)?.toUpperCase();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!isValidSecretName(name)) {
    return c.json({ error: 'name must be a valid env var name (A-Z, 0-9, _; max 64 chars)' }, 400);
  }
  if (name.startsWith('KORTIX_')) {
    return c.json({ error: 'KORTIX_* names are reserved for platform/runtime-managed variables' }, 400);
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
  }

  const value = typeof body.value === 'string' ? body.value : null;

  // Optional sharing intent (project | private | members). Absent → leave
  // sharing as-is (column defaults to 'project' on first insert).
  let sharing: ReturnType<typeof parseSharingIntent> | undefined;
  if (body.sharing != null) {
    sharing = parseSharingIntent(body.sharing, loaded.userId);
    if (!sharing) {
      return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);
    }
  }

  // Look up the existing SHARED row so a sharing-only edit doesn't force
  // re-entering the value. Creating a brand-new secret still requires a value.
  const [existing] = await db
    .select({ secretId: projectSecrets.secretId })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      isNull(projectSecrets.ownerUserId),
    ))
    .limit(1);
  if (!existing && value === null) {
    return c.json({ error: 'value is required' }, 400);
  }

  const now = new Date();
  let secretId: string;
  if (value !== null) {
    const [row] = await db
      .insert(projectSecrets)
      .values({
        projectId,
        name,
        valueEnc: encryptProjectSecret(projectId, value),
        createdBy: loaded.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        // The shared row is unique on (project, name) WHERE owner_user_id IS NULL.
        target: [projectSecrets.projectId, projectSecrets.name],
        targetWhere: isNull(projectSecrets.ownerUserId),
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          updatedAt: now,
        },
      })
      .returning({ secretId: projectSecrets.secretId });
    secretId = row.secretId;
  } else {
    // Sharing-only update — touch updatedAt so the list reflects the change.
    await db
      .update(projectSecrets)
      .set({ updatedAt: now })
      .where(eq(projectSecrets.secretId, existing!.secretId));
    secretId = existing!.secretId;
  }

  if (sharing) await setSecretSharing(secretId, sharing);

  void propagateProjectSecretsToActiveSandboxes(projectId);

  const subject = await resolveShareSubject(loaded.userId);
  const views = await loadSecretViewsForUser(projectId, subject, true);
  const view = views.find((v) => v.name === name);
  return c.json(view ?? { name }, 200);
},
);

// POST /v1/projects/:projectId/providers/openai/chatgpt/headless/start
// Starts the OpenCode ChatGPT Pro/Plus headless device-code flow on the API
// server. This deliberately does not require a running sandbox: provider
// credentials are project configuration, and sandboxes only consume the saved
// CODEX_AUTH_JSON secret later.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/providers/openai/chatgpt/headless/start',
    tags: ['secrets'],
    summary: 'POST /:projectId/providers/openai/chatgpt/headless/start',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 500),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  try {
    return c.json(await startChatGptHeadlessAuth({
      projectId,
      userId: loaded.userId,
    }));
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to start ChatGPT authorization',
    }, 500);
  }
},
);

// POST /v1/projects/:projectId/providers/openai/chatgpt/headless/complete
// Waits for the server-side OpenCode device flow to complete, then writes the
// resulting auth.json into project_secrets as CODEX_AUTH_JSON. This is
// intentionally Codex-specific; generic OpenCode auth can keep using its own
// OPENCODE_AUTH_JSON row without being overwritten by subscription onboarding.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/providers/openai/chatgpt/headless/complete',
    tags: ['secrets'],
    summary: 'POST /:projectId/providers/openai/chatgpt/headless/complete',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 500),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const authId = normalizeString(body.auth_id);
  if (!authId) return c.json({ error: 'auth_id is required' }, 400);

  let sharing: ReturnType<typeof parseSharingIntent> | undefined;
  if (body.sharing != null) {
    sharing = parseSharingIntent(body.sharing, loaded.userId);
    if (!sharing) {
      return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);
    }
  }
  if (sharing?.mode !== 'private' && !roleAllows(loaded.effectiveRole, 'manage')) {
    return c.json({ error: 'Only project managers can configure shared provider credentials' }, 403);
  }

  try {
    const value = await completeChatGptHeadlessAuth({
      authId,
      projectId,
      userId: loaded.userId,
    });

    const now = new Date();
    if (sharing?.mode === 'private') {
      await db
        .insert(projectSecrets)
        .values({
          projectId,
          name: CODEX_AUTH_JSON_SECRET_NAME,
          valueEnc: encryptProjectSecret(projectId, value),
          ownerUserId: loaded.userId,
          active: true,
          createdBy: loaded.userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [projectSecrets.projectId, projectSecrets.name, projectSecrets.ownerUserId],
          targetWhere: sql`${projectSecrets.ownerUserId} is not null`,
          set: {
            valueEnc: encryptProjectSecret(projectId, value),
            active: true,
            updatedAt: now,
          },
        });

      void propagateProjectSecretsToActiveSandboxes(projectId);

      const subject = await resolveShareSubject(loaded.userId);
      const views = await loadSecretViewsForUser(projectId, subject, true);
      const view = views.find((v) => v.name === CODEX_AUTH_JSON_SECRET_NAME);
      return c.json(view ?? { name: CODEX_AUTH_JSON_SECRET_NAME }, 200);
    }

    await db
      .insert(projectSecrets)
      .values({
        projectId,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptProjectSecret(projectId, value),
        createdBy: loaded.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectSecrets.projectId, projectSecrets.name],
        targetWhere: isNull(projectSecrets.ownerUserId),
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          updatedAt: now,
        },
      });

    const [row] = await db
      .select({ secretId: projectSecrets.secretId })
      .from(projectSecrets)
      .where(and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, CODEX_AUTH_JSON_SECRET_NAME),
        isNull(projectSecrets.ownerUserId),
      ))
      .limit(1);
    if (sharing && row) await setSecretSharing(row.secretId, sharing);

    void propagateProjectSecretsToActiveSandboxes(projectId);

    const subject = await resolveShareSubject(loaded.userId);
    const views = await loadSecretViewsForUser(projectId, subject, true);
    const view = views.find((v) => v.name === CODEX_AUTH_JSON_SECRET_NAME);
    return c.json(view ?? { name: CODEX_AUTH_JSON_SECRET_NAME }, 200);
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to complete ChatGPT authorization',
    }, 500);
  }
},
);

// DELETE /v1/projects/:projectId/secrets/:name

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/secrets/{name}',
    tags: ['secrets'],
    summary: 'DELETE /:projectId/secrets/:name',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), name: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const name = c.req.param('name')?.trim().toUpperCase();
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }
  if (isSystemProjectSecretName(name)) {
    return c.json({ error: `${name} is managed by Kortix and cannot be removed` }, 403);
  }

  // Only the shared row — members' personal overrides for this key are theirs to
  // remove (via the /personal route) and are left intact.
  await db
    .delete(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      isNull(projectSecrets.ownerUserId),
    ));

  void propagateProjectSecretsToActiveSandboxes(projectId);

  return c.json({ ok: true });
},
);

// PUT /v1/projects/:projectId/secrets/:name/personal
// Any project member sets/updates THEIR OWN per-key override (the "use mine"
// value) and/or flips whether it's active. Operates only on the caller's row;
// never touches the shared value or anyone else's override.

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/secrets/{name}/personal',
    tags: ['secrets'],
    summary: 'PUT /:projectId/secrets/:name/personal',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), name: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const name = c.req.param('name')?.trim().toUpperCase();
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }
  if (isSystemProjectSecretName(name)) {
    return c.json({ error: 'KORTIX_* names are reserved and cannot be overridden' }, 400);
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
  }

  const value = typeof body.value === 'string' ? body.value : null;
  const active = typeof body.active === 'boolean' ? body.active : undefined;
  if (value === null && active === undefined) {
    return c.json({ error: 'value or active is required' }, 400);
  }

  const [existingMine] = await db
    .select({ secretId: projectSecrets.secretId })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      eq(projectSecrets.ownerUserId, loaded.userId),
    ))
    .limit(1);

  const now = new Date();
  if (!existingMine) {
    if (value === null) {
      return c.json({ error: 'value is required to create an override' }, 400);
    }
    await db.insert(projectSecrets).values({
      projectId,
      name,
      valueEnc: encryptProjectSecret(projectId, value),
      ownerUserId: loaded.userId,
      active: active ?? true,
      createdBy: loaded.userId,
      updatedAt: now,
    });
  } else {
    await db
      .update(projectSecrets)
      .set({
        ...(value !== null ? { valueEnc: encryptProjectSecret(projectId, value) } : {}),
        ...(active !== undefined ? { active } : {}),
        updatedAt: now,
      })
      .where(eq(projectSecrets.secretId, existingMine.secretId));
  }

  void propagateProjectSecretsToActiveSandboxes(projectId);

  const subject = await resolveShareSubject(loaded.userId);
  const views = await loadSecretViewsForUser(projectId, subject, roleAllows(loaded.effectiveRole, 'manage'));
  return c.json(views.find((v) => v.name === name) ?? { name }, 200);
},
);

// DELETE /v1/projects/:projectId/secrets/:name/personal
// Remove the caller's own override for this key (falls back to the shared value).

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/secrets/{name}/personal',
    tags: ['secrets'],
    summary: 'DELETE /:projectId/secrets/:name/personal',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), name: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const name = c.req.param('name')?.trim().toUpperCase();
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }

  await db
    .delete(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      eq(projectSecrets.ownerUserId, loaded.userId),
    ));

  void propagateProjectSecretsToActiveSandboxes(projectId);

  return c.json({ ok: true });
},
);

// GET /v1/projects/:projectId/triggers
//
// Lists triggers defined as files in `.opencode/triggers/*.md` on the
// project's default branch, plus any parse errors and runtime state
// (last_fired_at). The repo is the source of truth — POST/PATCH/DELETE
// below commit/update/delete the underlying file.
