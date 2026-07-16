import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { managedGithubOwner, managedGithubOwnerType, managedGithubToken } from '../git-backends';
import {
  createInstallationToken,
  getRepo,
  listInstallationRepositories,
  listOwnerRepositories,
  listRepositoryBranches,
} from '../github';
import { resolveProjectAccount } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  createGitHubInstallationInstallUrl,
  getAccountGitHubInstallation,
} from '../lib/git';
import { PAT_MANAGED_GIT_INSTALLATION_ID, normalizeString, serializeGitHubRepo } from '../lib/serializers';
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
      ...errors(409, 502),
    },
  }),
  async (c: any) => {
    const scope = await resolveProjectAccount(c);
    await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

    const installationId = normalizeString(
      c.req.query('installation_id') ?? c.req.query('installationId'),
    );

    // The managed-git PAT ("Use a token" self-host setup) surfaces as a
    // synthetic installation (see serializeGitHubInstallations) since it has
    // no real GitHub App installation to list repos from — list via the PAT
    // itself instead of an installation token.
    if (installationId === PAT_MANAGED_GIT_INSTALLATION_ID) {
      const owner = managedGithubOwner();
      const token = managedGithubToken();
      if (!owner || !token) {
        return c.json({ error: 'The managed GitHub token is no longer configured on this server' }, 409);
      }
      try {
        const repos = await listOwnerRepositories({
          owner,
          ownerType: managedGithubOwnerType(),
          auth: { token },
        });
        return c.json({
          account_id: scope.accountId,
          installation_id: PAT_MANAGED_GIT_INSTALLATION_ID,
          owner_login: owner,
          repositories: repos.map(serializeGitHubRepo),
        });
      } catch (error) {
        return c.json({
          error: (error as Error).message || 'Failed to list GitHub repositories',
        }, 502);
      }
    }

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
    await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

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
      return c.json({
        error: (error as Error).message || 'Failed to list GitHub repository branches',
      }, 502);
    }
  },
);
