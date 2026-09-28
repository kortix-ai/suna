/** Project git access: sandbox git token, git connection, and collaborator invites. */
import { PROJECT_ACTIONS } from '../../iam';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { buildDenialError } from '../../iam/denial-message';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { auth, errors, json } from '../../openapi';
import { getBackend, parseBasicAuthHeader, type GitScope } from '../git-backends';
import { createRoute, z } from '@hono/zod-openapi';
import { loadProjectForUser, assertProjectCapability } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import {
  buildConnectionRef,
  getProjectGitConnection,
  getProjectGitRemote,
  resolveProjectGitAuth,
  resolveProjectGitConnection,
  resolveProjectUpstream,
} from '../lib/git';
import { normalizeString, serializeProject } from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';

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
  // This endpoint hands back a RAW git push credential. project.write is
  // fold-exempt, so without a leaf gate a read-scoped agent could mint a push
  // token and bypass every CR/commit gate. Gate on gitops.push: a custom role
  // can withhold it, and the agent fold requires it in the token's grant.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH);
  // Agents as principals (spec 2026-09-22 §2.4): an agent's authority is its
  // kortix.yaml entry, and a change to that entry needs a human merge. A raw
  // provider push credential would let the agent write the default branch
  // directly — its own grant included — past the session ref policy and the
  // merge guard. Under the flag an agent session pushes through the Kortix git
  // proxy only.
  if (isProjectSessionPrincipal(c) && resolveFeatureFlag(loaded.row.metadata, 'agent_principal')) {
    throw buildDenialError(
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
      'agent_human_only_action',
      'An agent session cannot receive a raw git push credential. Push through the Kortix git origin (git_origin_url).',
    );
  }

  const connection = await getProjectGitConnection(projectId);
  const remote = getProjectGitRemote(loaded.row, connection);
  if (!remote.managed) {
    return c.json({ error: 'Project is not a managed repo' }, 409);
  }

  // Provider-agnostic: resolve a fresh push credential through the backend seam
  // (the managed GitHub backend mints an installation token). Never persisted
  // in the sandbox/CLI git config.
  const gitAuth = await resolveProjectGitAuth(loaded.row);
  if (gitAuth.authSource === 'pat') {
    // This host's managed git runs on an org-wide token. Exporting it to a
    // client would hand out write access to EVERY managed repo, so we refuse —
    // clients push through the Kortix git proxy (`git_origin_url`) with their
    // own Kortix token instead, which needs no provider credential client-side.
    // Say so explicitly: the old message read as a server misconfiguration and
    // sent people hunting for GitHub App settings that aren't the problem.
    return c.json(
      {
        error:
          "This host's managed git uses an org-wide token, which is never exported. " +
          "Push through the project's Kortix git origin instead (git_origin_url) — " +
          'run `kortix update` if your CLI still asks for a push token.',
        git_origin_url: serializeProject(loaded.row).git_origin_url,
      },
      503,
    );
  }
  const upstream = await resolveProjectUpstream(loaded.row, 'write');
  const credential = parseBasicAuthHeader(upstream?.headers.Authorization);
  if (!credential) {
    return c.json({ error: 'Managed git is not configured / unavailable for this project' }, 503);
  }

  return c.json({
    push_token: credential.token,
    git_username: credential.username,
    repo_id: remote.externalRepoId,
    repo_url: upstream?.url ?? loaded.row.repoUrl,
  });
},
);

// POST /v1/projects/:projectId/git/collaborators
// GET /v1/projects/:projectId/git/connection
// Is this project's git connection usable, and if not can the account fix it?
//
// Exists so the UI can show "Reconnect GitHub" BEFORE someone triggers a push
// that fails. A stored GitHub App installation stops minting tokens when it is
// uninstalled, or when the App identity itself changes — GitHub 404s the mint
// either way — and until this endpoint there was no way to see that without
// attempting a git operation and reading the error.
//
// `reconnect_required` is the only state that carries an install URL: the other
// failures are ours (managed-git down, an unparseable repo URL), and sending
// someone to reinstall would not help.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/git/connection',
    tags: ['github'],
    summary: 'GET /:projectId/git/connection',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(
        z.object({
          state: z.enum(['connected', 'reconnect_required', 'unavailable', 'not_connected']),
          reason: z.string().optional(),
          install_url: z.string().nullable().optional(),
        }),
        "The project's git connection state",
      ),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const connection = await resolveProjectGitConnection(loaded.row, loaded.userId);
    return c.json({
      state: connection.state,
      ...(connection.reason ? { reason: connection.reason } : {}),
      ...(connection.installUrl !== undefined ? { install_url: connection.installUrl } : {}),
    });
  },
);

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
  // Inviting a git collaborator grants a human standing access to the repo —
  // membership-tier, not plain write. Gate on members.manage so a member (or a
  // scoped agent via the fold) can't add external collaborators.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const body = await readJsonObject(c);
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
