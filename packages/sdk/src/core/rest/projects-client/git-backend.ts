// The instance git backend — "Kortix managed" git, one deployment-wide thing.
//
// It is NOT an account GitHub connection: an account connects its own GitHub
// App installations (see `./github`), while this backend is the single owner
// plus credential the deployment itself uses to create managed repositories.
// The two never appear in one list.

import { backendApi } from '../../http/api-client';
import type { GitHubRepository } from './github';
import { unwrap } from './shared';

export interface ManagedGitBackend {
  /** Whether this deployment can create managed repositories at all. */
  configured: boolean;
  /** `'app'` = a GitHub App installation, `'pat'` = a server-side token. */
  kind: 'app' | 'pat' | null;
  /** The GitHub user or org that owns every managed repository. */
  owner: string | null;
}

export interface ManagedGitRepositoriesResponse {
  owner: string;
  repositories: GitHubRepository[];
}

/**
 * Read the instance git backend. Any authenticated user may call it: it
 * exposes only the owner login, which every managed `project.repo_url`
 * already carries.
 */
export async function getManagedGitBackend(): Promise<ManagedGitBackend> {
  return unwrap(
    await backendApi.get<ManagedGitBackend>('/projects/git/backend', { showErrors: false }),
  );
}

/**
 * List the repositories under the instance backend's owner. Self-host
 * operators only — on cloud that owner holds every customer's project repo,
 * so the API answers 403 for anyone else.
 */
export async function listManagedGitRepositories(options?: {
  search?: string;
  limit?: number;
}): Promise<ManagedGitRepositoriesResponse> {
  const params = new URLSearchParams();
  const search = options?.search?.trim();
  if (search) params.set('search', search);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  return unwrap(
    await backendApi.get<ManagedGitRepositoriesResponse>(
      `/projects/git/backend/repositories${query ? `?${query}` : ''}`,
      { showErrors: false },
    ),
  );
}
