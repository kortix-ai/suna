import {
  searchWorkspaceFilePaths,
} from '../search/workspace-search-service';

/**
 * One-shot async file+folder search with ranking.
 * Returns plain `string[]` paths (dirs have trailing `/`).
 */
export async function searchWorkspaceFiles(
  query: string,
  limit = 50,
): Promise<string[]> {
  return searchWorkspaceFilePaths(query, { limit, apiLimit: Math.max(limit, 100) });
}
