import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { config } from '../../config';
import { auth, errors, json } from '../../openapi';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { managedGithubOwner, managedGithubOwnerType, managedGithubToken } from '../git-backends';
import {
  getRepo,
  listOwnerRepositories,
  listRepositoryBranches,
} from '../github';
import { resolveProjectAccount } from '../lib/access';
import { projectsApp } from '../lib/app';
import { getAccountGitHubInstallation } from '../lib/git';
import {
  PAT_MANAGED_GIT_INSTALLATION_ID,
  normalizeString,
  serializeGitHubRepo,
} from '../lib/serializers';
import {
  GitHubCredentialResolutionError,
  withFreshAccountGithubRead,
} from '../nango/account-credential';
import { enforcePatImportMode } from '../nango/credential-mode';
import { GitHubRepositoryValidationError } from '../nango/repository-operations';
import { mapGitHubOperationError } from './github-errors';
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

// biome-ignore lint/suspicious/noExplicitAny: Hono cannot type a mapped runtime status code.
function githubErrorResponse(context: any, error: unknown) {
  const mapped = mapGitHubOperationError(error);
  if (mapped.retryAfter) context.header('Retry-After', mapped.retryAfter);
  return context.json(mapped.body, mapped.status);
}

// GET /v1/projects/github/repositories?account_id=...

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/repositories',
    tags: ['github'],
    summary: 'List repositories available to a GitHub connection',
    ...auth,
    request: {
      query: z.object({}).passthrough(),
    },
    responses: {
      200: json(z.any(), 'Repositories available to the installation'),
      ...errors(403, 404, 409, 429, 502, 503),
    },
  }),
  // biome-ignore lint/suspicious/noExplicitAny: zod-openapi cannot infer a passthrough query route.
  async (c: any) => {
    const scope = await resolveProjectAccount(c);
    await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

    const installationId = normalizeString(
      c.req.query('installation_id') ?? c.req.query('installationId'),
    );
    const search = normalizeString(c.req.query('search'))?.slice(0, 120) ?? undefined;
    const requestedLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 100;

    // The managed-git PAT ("Use a token" self-host setup) surfaces as a
    // synthetic installation (see serializeGitHubInstallations) since it has
    // no real GitHub App installation to list repos from — list via the PAT
    // itself instead of an installation token.
    if (installationId === PAT_MANAGED_GIT_INSTALLATION_ID) {
      try {
        enforcePatImportMode(config.GITHUB_CREDENTIAL_RESOLUTION);
      } catch (error) {
        return githubErrorResponse(c, error);
      }
      if (!(await isPlatformAdmin(scope.userId))) {
        return c.json(
          { error: 'Managed GitHub repository import requires platform admin access' },
          403,
        );
      }
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
          search,
          limit,
        });
        return c.json({
          account_id: scope.accountId,
          installation_id: PAT_MANAGED_GIT_INSTALLATION_ID,
          owner_login: owner,
          repositories: repos.map(serializeGitHubRepo),
        });
      } catch (error) {
        return githubErrorResponse(c, error);
      }
    }

    try {
      const selected = await getAccountGitHubInstallation(
        scope.accountId,
        installationId,
      );
      const resolvedInstallationId =
        selected?.installationId ?? installationId ?? '';
      if (!resolvedInstallationId) {
        throw new GitHubCredentialResolutionError(
          'github_connection_required',
          409,
          scope.accountId,
          '',
        );
      }
      const { installation, repos } = await withFreshAccountGithubRead(
        {
          accountId: scope.accountId,
          installationId: resolvedInstallationId,
        },
        async ({ installation, credential }) => ({
          installation,
          repos: await listOwnerRepositories({
            owner: installation.ownerLogin,
            ownerType: installation.ownerType === 'User' ? 'User' : 'Organization',
            auth: { token: credential.userToken },
            search,
            limit,
          }),
        }),
      );
      return c.json({
        account_id: scope.accountId,
        installation_id: installation.installationId,
        owner_login: installation.ownerLogin,
        repositories: repos.map(serializeGitHubRepo),
      });
    } catch (error) {
      return githubErrorResponse(c, error);
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
      ...errors(400, 403, 404, 409, 429, 502, 503),
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

    try {
      const { installation, repo, branches } = await withFreshAccountGithubRead(
        {
          accountId: scope.accountId,
          installationId,
        },
        async ({ installation, credential }) => {
          if (owner.toLowerCase() !== installation.ownerLogin.toLowerCase()) {
            throw new GitHubRepositoryValidationError('github_repository_not_found', 404);
          }
          const authContext = { token: credential.userToken };
          const [repo, branches] = await Promise.all([
            getRepo({ owner, repo: repoName, auth: authContext }),
            listRepositoryBranches({ owner, repo: repoName, auth: authContext }),
          ]);
          return { installation, repo, branches };
        },
      );
      if (repo.full_name.toLowerCase() !== `${owner}/${repoName}`.toLowerCase()) {
        return c.json(
          {
            error: 'The selected GitHub repository no longer exists.',
            code: 'github_repository_not_found',
          },
          404,
        );
      }
      return c.json({
        account_id: scope.accountId,
        installation_id: installation.installationId,
        owner_login: installation.ownerLogin,
        repo_full_name: repo.full_name,
        default_branch: repo.default_branch,
        branches,
      }, 200);
    } catch (error) {
      return githubErrorResponse(c, error);
    }
  },
);
