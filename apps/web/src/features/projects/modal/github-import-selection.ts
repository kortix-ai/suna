import type { GitHubRepositoryBranchesResponse } from '@kortix/sdk';

export function resolveGitHubBranchSelection(
  response: GitHubRepositoryBranchesResponse,
  current: string,
): string {
  if (current && response.branches.some((branch) => branch.name === current)) return current;
  if (response.branches.some((branch) => branch.name === response.default_branch)) {
    return response.default_branch;
  }
  return response.branches[0]?.name ?? '';
}
