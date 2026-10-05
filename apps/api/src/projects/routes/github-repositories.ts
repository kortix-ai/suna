import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { actorOf } from '../../iam/actor';
import { auth, errors, json } from '../../openapi';
import {
  createInstallationToken,
  getRepo,
  listInstallationRepositories,
  listRepositoryBranches,
} from '../github';
import { resolveProjectAccount } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  createGitHubInstallationInstallUrl,
  getAccountGitHubInstallation,
} from '../lib/git';
import {
  githubInstallationUnreachableBody,
  isGitHubInstallationUnreachable,
} from '../lib/github-installation-errors';
import { normalizeString, serializeGitHubRepo } from '../lib/serializers';
import { createRoute, z } from '@hono/zod-openapi';

const RepositoryBranchesResponseSchema = z.object({
  account_id: z.string(),
  installation_id: z.string(),
  owner_login: z.string(),
  repo_full_name: z.string(),
  default_branch: z.string(),
  branches: z.array(z.object({
    name: z.string(),
    protected: z.boolean(),
  })),
}).openapi('RepositoryBranchesResponse');

// GET /v1/projects/github/repositories?account_id=...
//
// Repositories an ACCOUNT connection can see. The instance backend ("Kortix
// managed") is a different concept and lives under its own namespace,
// GET /v1/projects/git/backend/repositories — it never appears here, because
// on cloud its owner holds every customer's project repository.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/repositories',
    tags: ['github'],
    summary: 'List repositories available to a GitHub App installation',
    ...auth,
    request: {
      query: z.object({}).passthrough(),
    },
    responses: {
      200: json(z.any(), 'Repositories available to the installation'),
      ...errors(403, 409, 502),
    },
  }),
  async (c: any) => {
    const scope = await resolveProjectAccount(c);
    await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE);

    const installationId = normalizeString(
      c.req.query('installation_id') ?? c.req.query('installationId'),
    );
    const search = normalizeString(c.req.query('search'))?.slice(0, 120) ?? undefined;
    const requestedLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 100;

    // A read-only browse: with no id it shows the oldest connection's repos.
    // The write paths (create-repo, link-repository) use
    // `requireAccountGitHubInstallation` instead and refuse to guess.
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
      const repos = await listInstallationRepositories(installation.installationId, {
        owner: installation.ownerLogin,
        ownerType: installation.ownerType === 'User' ? 'User' : 'Organization',
        search,
        limit,
      });
      return c.json({
        account_id: scope.accountId,
        installation_id: installation.installationId,
        owner_login: installation.ownerLogin,
        repositories: repos.map(serializeGitHubRepo),
      });
    } catch (error) {
      if (isGitHubInstallationUnreachable(error)) {
        return c.json(
          githubInstallationUnreachableBody(
            installation.installationId,
            await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
          ),
          409,
        );
      }
      return c.json({
        error: (error as Error).message || 'Failed to list GitHub repositories',
      }, 502);
    }
  },
);

// GET /v1/projects/github/repository-branches?account_id=...&installation_id=...&repo_full_name=...

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/repository-branches',
    tags: ['github'],
    summary: 'List existing branches for a GitHub repository',
    ...auth,
    request: {
      query: z.object({
        account_id: z.string().min(1),
        installation_id: z.string().regex(/^\d+$/),
        repo_full_name: z.string().min(3),
      }),
    },
    responses: {
      200: json(RepositoryBranchesResponseSchema, 'Repository branches'),
      ...errors(400, 409, 502),
    },
  }),
  async (c) => {
    const scope = await resolveProjectAccount(c);
    await assertAuthorized(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.PROJECT_CREATE);

    const installationId = c.req.valid('query').installation_id;
    const repoFullName = c.req.valid('query').repo_full_name;
    const [owner, repoName, extra] = repoFullName.split('/');
    if (!owner || !repoName || extra) {
      return c.json({ error: 'repo_full_name must use the owner/repository format' }, 400);
    }

    const installation = await getAccountGitHubInstallation(scope.accountId, installationId);
    if (!installation) {
      return c.json({
        error: 'Selected GitHub installation is not connected to this account',
        install_url: await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
      }, 409);
    }
    if (owner.toLowerCase() !== installation.ownerLogin.toLowerCase()) {
      return c.json({
        error: `GitHub installation ${installationId} belongs to ${installation.ownerLogin}`,
      }, 400);
    }

    try {
      const token = await createInstallationToken(installation.installationId);
      const authContext = { token: token.token };
      const [repo, branches] = await Promise.all([
        getRepo({ owner, repo: repoName, auth: authContext }),
        listRepositoryBranches({ owner, repo: repoName, auth: authContext }),
      ]);
      return c.json({
        account_id: scope.accountId,
        installation_id: installation.installationId,
        owner_login: installation.ownerLogin,
        repo_full_name: repo.full_name,
        default_branch: repo.default_branch,
        branches,
      }, 200);
    } catch (error) {
      if (isGitHubInstallationUnreachable(error)) {
        return c.json(
          githubInstallationUnreachableBody(
            installation.installationId,
            await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
          ),
          409,
        );
      }
      return c.json({
        error: (error as Error).message || 'Failed to list GitHub repository branches',
      }, 502);
    }
  },
);
