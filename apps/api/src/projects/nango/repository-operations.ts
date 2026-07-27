import type { GitHubAuthContext, GitHubBranch, GitHubRepo } from '../github';

export type GitHubRepositoryValidationCode =
  | 'github_insufficient_permissions'
  | 'github_repository_not_found';

export class GitHubRepositoryValidationError extends Error {
  constructor(
    readonly code: GitHubRepositoryValidationCode,
    readonly status: 403 | 404,
  ) {
    super(
      code === 'github_insufficient_permissions'
        ? 'The GitHub connection does not have write access to this repository.'
        : 'The selected GitHub repository or branch no longer exists.',
    );
    this.name = 'GitHubRepositoryValidationError';
  }
}

interface RepositoryImportValidationInput {
  expectedOwner: string;
  expectedName: string;
  expectedRepositoryId?: string | null;
  requestedBranch?: string | null;
  repo: GitHubRepo;
  auth?: Pick<GitHubAuthContext, 'token'>;
}

interface RepositoryImportValidationDependencies {
  getBranch(input: {
    owner: string;
    repo: string;
    branch: string;
    auth?: Pick<GitHubAuthContext, 'token'>;
  }): Promise<GitHubBranch>;
}

function canPush(repo: GitHubRepo): boolean {
  const permissions = repo.permissions;
  return Boolean(permissions?.admin || permissions?.maintain || permissions?.push);
}

export async function validateNangoRepositoryImport(
  input: RepositoryImportValidationInput,
  dependencies: RepositoryImportValidationDependencies,
): Promise<{ defaultBranch: string }> {
  const [actualOwner, actualName, extra] = input.repo.full_name.split('/');
  const identityMatches =
    !extra &&
    actualOwner?.toLowerCase() === input.expectedOwner.toLowerCase() &&
    actualName?.toLowerCase() === input.expectedName.toLowerCase() &&
    input.repo.name.toLowerCase() === input.expectedName.toLowerCase() &&
    (!input.expectedRepositoryId || String(input.repo.id) === String(input.expectedRepositoryId));

  if (!actualOwner || !actualName || !identityMatches) {
    throw new GitHubRepositoryValidationError('github_repository_not_found', 404);
  }
  if (!canPush(input.repo)) {
    throw new GitHubRepositoryValidationError('github_insufficient_permissions', 403);
  }

  const defaultBranch =
    input.requestedBranch?.trim() || input.repo.default_branch?.trim() || 'main';
  try {
    await dependencies.getBranch({
      owner: actualOwner,
      repo: actualName,
      branch: defaultBranch,
      ...(input.auth ? { auth: input.auth } : {}),
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
      throw new GitHubRepositoryValidationError('github_repository_not_found', 404);
    }
    throw error;
  }

  return { defaultBranch };
}
