import type { GitHubRepo } from "./github-http";
export interface GitHubInstallationRepositories {
  total_count: number;
  repositories: GitHubRepo[];
}

export interface GitHubRepositorySearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepo[];
}

export interface RepositoryListOptions {
  owner?: string;
  ownerType?: 'User' | 'Organization';
  search?: string;
  limit?: number;
}

