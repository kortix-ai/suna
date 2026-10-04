/** Project credentials: project-scoped CLI tokens and the BYO git credential. */
import { PROJECT_ACTIONS } from '../../iam';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json, lenientBody } from '../../openapi';
import {
  PatPolicyError,
  createAccountToken,
  listAccountTokens,
  revokeAccountToken,
} from '../../repositories/account-tokens';
import { createRoute, z } from '@hono/zod-openapi';
import {
  loadProjectForUser,
  assertProjectCapability,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  getProjectGitConnection,
  getProjectGitRemote,
  hasServerManagedGitAuth,
  upsertProjectGitConnection,
  upsertProjectGitCredential,
} from '../lib/git';
import { normalizeString, serializeProjectGitConnection } from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
export function registerProjectCredentialsRoutes(): void {
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
      summary: 'List CLI tokens of a project',
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
      summary: 'Create a project CLI token (API key)',
      description:
        'Create a project-scoped API key. The token value is returned once, in the response.',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              name: z.string().optional().openapi({ description: 'Token label. Default "cli - <project name>".' }),
              expires_at: z.string().optional().openapi({ description: 'ISO-8601 expiry. Omit for a token that does not expire.' }),
            }) } } },
        },
      responses: {
          201: json(z.any(), 'OK'),
          ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
    // A connected app's revocable `kortix_oat_` token must not mint a durable one.
    if (c.get('authType') === 'oauth') {
      return c.json({ error: 'Connected apps cannot mint project tokens.' }, 403);
    }
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'credentials');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Authorization is enforced by loadProjectForUser(... 'credentials') above:
    // `project.credentials.issue`, its own leaf. It used to be 'manage', which
    // mapped to project.write — so anyone who could edit the project could mint a
    // long-lived project credential (routes.md §5.2).

    // Privilege-escalation guard: an agent-session token is itself a project
    // account token carrying a (possibly narrow) AgentGrant. If it could mint a
    // fresh project token, the new token would carry NO grant — letting a scoped
    // agent issue an unscoped sibling and escape its own ceiling. Token minting
    // is a human/manage operation; agents are denied outright. Keyed on the
    // session binding, not on the grant: a session of a project without
    // `[[agents]]` carries a NULL grant and is still a session credential.
    if (isProjectSessionPrincipal(c)) {
      return c.json({ error: 'Agent-session tokens cannot mint project tokens' }, 403);
    }

    // Body fields: `name` (defaults to "cli · <project name>") and an optional
    // ISO-8601 `expires_at`. The account's PAT policy (require expiry, maximum
    // lifetime) applies to this token like any other durable PAT.
    const body = await readJsonObject(c);
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 255)
        : `cli · ${loaded.row.name}`;
    const expiresAtRaw = typeof body.expires_at === 'string' ? body.expires_at.trim() : '';
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : undefined;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return c.json({ error: 'expires_at must be ISO-8601' }, 400);
    }

    const userId = c.get('userId') as string;
    let created;
    try {
      created = await createAccountToken({
        accountId: loaded.row.accountId,
        userId,
        projectId,
        name,
        expiresAt,
      });
    } catch (err) {
      if (err instanceof PatPolicyError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }

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
      summary: 'Revoke a project CLI token',
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
    const loaded = await loadProjectForUser(c, projectId, 'credentials');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Authorization is enforced by loadProjectForUser(... 'credentials') above.
    // Token management is a human/manage operation: an agent-session token must
    // not revoke project tokens (it could knock out its own siblings / the human
    // CLI token as a DoS). Symmetric with the mint guard above.
    if (isProjectSessionPrincipal(c)) {
      return c.json({ error: 'Agent-session tokens cannot manage project tokens' }, 403);
    }
    const ok = await revokeAccountToken(tokenId, loaded.row.accountId, projectId);
    if (!ok) return c.json({ error: 'token not found or already revoked' }, 404);
    return c.json({ ok: true });
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
      summary: 'Set the project Git credential',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              token: z.string().openapi({ description: 'Git access token for the repository. value is accepted as an alias.' }),
              provider: z.string().optional().openapi({ description: 'Git provider name. Defaults from the repository remote.' }),
            }) } } },
        },
      responses: {
          200: json(z.any(), 'OK'),
          ...errors(400, 404, 409),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readJsonObject(c);
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Storing a git credential is a connector-write capability — a custom role can
    // omit project.connector.write to take credential management away from a
    // department, and an agent grant must include it (central fold) to write one.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);

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
}
