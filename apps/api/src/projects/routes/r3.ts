import { randomUUID } from 'node:crypto';
import { parseSharingIntent, resolveShareSubject, setSecretSharing } from '../../executor/share';
import { auth, errors, json } from '../../openapi';
import { createAccountToken, listAccountTokens, revokeAccountToken } from '../../repositories/account-tokens';
import { db } from '../../shared/db';
import { kickPreBuild } from '../../snapshots/builder';
import { getTemplateById } from '../../snapshots/templates';
import { roleAllows } from '../access';
import { loadProjectConfig } from '../git';
import { runChatGptHeadlessAuth } from '../opencode-chatgpt-auth';
import { decryptProjectSecret, encryptProjectSecret, isValidSecretName } from '../secrets';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { createRoute, z } from '@hono/zod-openapi';
import { oauthProviderFlows, projectSecrets, projects, sessionSandboxes } from '@kortix/db';
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

// ─── Provider OAuth device flow (poll-based) ───────────────────────────────
//
// Connect a subscription-backed LLM provider (today: a ChatGPT Plus/Pro
// account via the OpenAI Codex device grant) and save the resulting login as
// the project's CODEX_AUTH_JSON secret — which sandboxes materialize into
// OpenCode's auth.json on boot. No sandbox is required to connect.
//
// Two quick, NON-streaming calls so they survive any edge (a long-lived
// streaming response gets reset by Cloudflare) and any replica:
//   POST …/oauth/:provider/start → kicks the device flow in a DETACHED
//        background task on this replica, returns the device challenge.
//   POST …/oauth/:provider/poll  → ANY replica reads the shared DB flow row;
//        once the user finishes authorizing, writes the secret and returns it.
// The in-flight flow lives in `kortix.oauth_provider_flows` (not replica
// memory), so start and poll need not hit the same pod. The detached task
// isn't tied to a client connection, so nothing the edge does can kill it.

// Kortix provider id → the secret we persist the resulting auth.json under.
// Only OpenAI (ChatGPT) is wired today; the shape generalizes to others.
const OAUTH_PROVIDERS: Record<string, { secretName: string }> = {
  openai: { secretName: CODEX_AUTH_JSON_SECRET_NAME },
};

// Overall cap on a device flow (OpenAI device codes expire well before this).
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
// How long `start` waits for OpenCode to surface the device challenge.
const OAUTH_CHALLENGE_TIMEOUT_MS = 30 * 1000;
// Suggested client poll cadence.
const OAUTH_POLL_INTERVAL_MS = 3000;

// Persists the Codex auth.json as the CODEX_AUTH_JSON project secret with the
// requested sharing, then returns the caller's view of it. Codex-specific on
// purpose: a generic OPENCODE_AUTH_JSON row is never overwritten by this.
async function writeCodexAuthSecret(input: {
  projectId: string;
  userId: string;
  value: string;
  sharing?: ReturnType<typeof parseSharingIntent>;
}) {
  const { projectId, userId, value, sharing } = input;
  const now = new Date();

  if (sharing?.mode === 'private') {
    await db
      .insert(projectSecrets)
      .values({
        projectId,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptProjectSecret(projectId, value),
        ownerUserId: userId,
        active: true,
        createdBy: userId,
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
  } else {
    await db
      .insert(projectSecrets)
      .values({
        projectId,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptProjectSecret(projectId, value),
        createdBy: userId,
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
  }

  void propagateProjectSecretsToActiveSandboxes(projectId);

  const subject = await resolveShareSubject(userId);
  const views = await loadSecretViewsForUser(projectId, subject, true);
  return views.find((v) => v.name === CODEX_AUTH_JSON_SECRET_NAME)
    ?? { name: CODEX_AUTH_JSON_SECRET_NAME };
}

// Best-effort token expiry (ms remaining) from a stored auth.json, for display.
function authExpiresInMs(authJson: string): number | null {
  try {
    const parsed = JSON.parse(authJson);
    // opencode auth.json is keyed by provider: { openai: { expires, ... } }.
    for (const entry of Object.values(parsed ?? {})) {
      const expires = (entry as { expires?: unknown })?.expires;
      if (typeof expires === 'number' && Number.isFinite(expires)) {
        return Math.max(0, expires - Date.now());
      }
    }
  } catch {
    // not parseable / no expiry — treat as unknown
  }
  return null;
}

// ─── POST /v1/projects/:projectId/oauth/:provider/start ────────────────────
// Kick the device flow in a detached background task; return the challenge.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/oauth/{provider}/start',
    tags: ['secrets'],
    summary: 'POST /:projectId/oauth/:provider/start',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), provider: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Device challenge'),
        ...errors(400, 401, 403, 404, 502),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (!OAUTH_PROVIDERS[provider]) {
    return c.json({ error: `OAuth device flow is not available for "${provider}"` }, 400);
  }

  let sharing: ReturnType<typeof parseSharingIntent> | undefined;
  if (body.sharing != null) {
    sharing = parseSharingIntent(body.sharing, loaded.userId);
    if (!sharing) {
      return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);
    }
  }
  // A shared credential needs manage; a private (owner-only) one just needs read.
  if (sharing?.mode !== 'private' && !roleAllows(loaded.effectiveRole, 'manage')) {
    return c.json({ error: 'Only project managers can configure shared provider credentials' }, 403);
  }

  const userId = loaded.userId;
  const flowId = randomUUID();
  const expiresAt = new Date(Date.now() + OAUTH_FLOW_TTL_MS);

  await db.insert(oauthProviderFlows).values({
    flowId,
    projectId,
    userId,
    provider,
    status: 'pending',
    sharing: sharing ? (sharing as unknown) : null,
    expiresAt,
  });

  // Drive the real device flow detached from this request. It surfaces the
  // challenge (resolved below), then blocks on the user finishing in the
  // browser, then writes the encrypted auth.json onto the flow row. Not tied
  // to any client connection, so the edge can't reset it.
  let resolveChallenge: (c: { url: string; code: string | null } | null) => void = () => {};
  const challengePromise = new Promise<{ url: string; code: string | null } | null>((r) => {
    resolveChallenge = r;
  });
  let backgroundError: string | null = null;

  void runChatGptHeadlessAuth({
    signal: AbortSignal.timeout(OAUTH_FLOW_TTL_MS),
    onChallenge: (challenge) => resolveChallenge({ url: challenge.url, code: challenge.code }),
  })
    .then((value) =>
      db
        .update(oauthProviderFlows)
        .set({ status: 'ready', authJsonEnc: encryptProjectSecret(projectId, value), updatedAt: new Date() })
        .where(eq(oauthProviderFlows.flowId, flowId)),
    )
    .catch(async (err) => {
      backgroundError = err instanceof Error ? err.message : 'ChatGPT authorization failed';
      resolveChallenge(null); // unblock `start` if it failed before the challenge
      await db
        .update(oauthProviderFlows)
        .set({ status: 'failed', error: backgroundError, updatedAt: new Date() })
        .where(eq(oauthProviderFlows.flowId, flowId))
        .catch(() => {});
    });

  const challenge = await Promise.race([
    challengePromise,
    new Promise<null>((r) => setTimeout(() => r(null), OAUTH_CHALLENGE_TIMEOUT_MS)),
  ]);

  if (!challenge) {
    await db.delete(oauthProviderFlows).where(eq(oauthProviderFlows.flowId, flowId)).catch(() => {});
    return c.json({ error: backgroundError ?? 'Timed out starting the authorization flow' }, 502);
  }

  await db
    .update(oauthProviderFlows)
    .set({ verificationUrl: challenge.url, userCode: challenge.code, updatedAt: new Date() })
    .where(eq(oauthProviderFlows.flowId, flowId));

  return c.json({
    flow_id: flowId,
    verification_url: challenge.url,
    user_code: challenge.code,
    expires_at: expiresAt.getTime(),
    interval_ms: OAUTH_POLL_INTERVAL_MS,
  });
},
);

// ─── POST /v1/projects/:projectId/oauth/:provider/poll ─────────────────────
// Any replica: read the shared flow row; on success persist the secret.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/oauth/{provider}/poll',
    tags: ['secrets'],
    summary: 'POST /:projectId/oauth/:provider/poll',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), provider: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Poll result'),
        ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const flowId = normalizeString(body.flow_id);
  if (!flowId) return c.json({ error: 'flow_id is required' }, 400);

  const [flow] = await db
    .select()
    .from(oauthProviderFlows)
    .where(eq(oauthProviderFlows.flowId, flowId))
    .limit(1);

  // Not found / wrong project / wrong user / wrong provider → expired (the CLI
  // and UI just restart). Only the initiating member may poll their own flow.
  if (
    !flow ||
    flow.projectId !== projectId ||
    flow.userId !== loaded.userId ||
    flow.provider !== provider
  ) {
    return c.json({ status: 'expired' });
  }

  if (flow.expiresAt < new Date()) {
    await db.delete(oauthProviderFlows).where(eq(oauthProviderFlows.flowId, flowId)).catch(() => {});
    return c.json({ status: 'expired' });
  }

  if (flow.status === 'failed') {
    await db.delete(oauthProviderFlows).where(eq(oauthProviderFlows.flowId, flowId)).catch(() => {});
    return c.json({ status: 'failed', error: flow.error ?? 'Authorization failed' });
  }

  if (flow.status === 'pending' || !flow.authJsonEnc) {
    return c.json({ status: 'pending', next_poll_ms: OAUTH_POLL_INTERVAL_MS });
  }

  // status === 'ready' — persist the auth.json as the project secret, once.
  const value = decryptProjectSecret(projectId, flow.authJsonEnc);
  const sharing = flow.sharing
    ? (parseSharingIntent(flow.sharing, loaded.userId) ?? undefined)
    : undefined;
  await writeCodexAuthSecret({ projectId, userId: loaded.userId, value, sharing });
  await db.delete(oauthProviderFlows).where(eq(oauthProviderFlows.flowId, flowId)).catch(() => {});

  return c.json({
    status: 'success',
    credential: {
      provider_id: provider,
      expires_in_ms: authExpiresInMs(value),
      updated_at: new Date().toISOString(),
    },
  });
},
);

// ─── GET /v1/projects/:projectId/oauth ─────────────────────────────────────
// List configured OAuth credentials (derived from the saved project secrets).
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/oauth',
    tags: ['secrets'],
    summary: 'GET /:projectId/oauth',
    ...auth,
      request: { params: z.object({ projectId: z.string() }) },
    responses: {
        200: json(z.any(), 'Configured OAuth credentials'),
        ...errors(401, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const items: Array<{ provider_id: string; expires_in_ms: number | null; updated_at: string }> = [];
  for (const [providerId, cfg] of Object.entries(OAUTH_PROVIDERS)) {
    const [row] = await db
      .select({ valueEnc: projectSecrets.valueEnc, updatedAt: projectSecrets.updatedAt })
      .from(projectSecrets)
      .where(and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, cfg.secretName),
        isNull(projectSecrets.ownerUserId),
      ))
      .limit(1);
    if (!row) continue;
    let expiresInMs: number | null = null;
    try {
      expiresInMs = authExpiresInMs(decryptProjectSecret(projectId, row.valueEnc));
    } catch {
      // unreadable — leave unknown
    }
    items.push({
      provider_id: providerId,
      expires_in_ms: expiresInMs,
      updated_at: (row.updatedAt ?? new Date()).toISOString(),
    });
  }

  return c.json({ items });
},
);

// ─── DELETE /v1/projects/:projectId/oauth/:provider ────────────────────────
// Remove an OAuth credential (deletes the backing secret).
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/oauth/{provider}',
    tags: ['secrets'],
    summary: 'DELETE /:projectId/oauth/:provider',
    ...auth,
      request: { params: z.object({ projectId: z.string(), provider: z.string() }) },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) return c.json({ error: 'Not found' }, 404);

  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, cfg.secretName)));
  void propagateProjectSecretsToActiveSandboxes(projectId);

  return c.json({ ok: true });
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
