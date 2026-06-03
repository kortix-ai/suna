/**
 * File search utilities — searches workspace files via the sandbox API.
 *
 * Extracted from useMentions.ts so it can be shared with the CommandPalette.
 * Now delegates to workspace-search-service for robust deep-path matching.
 */

import { searchWorkspaceFilePaths } from './workspace-search-service';

export function rankFile(path: string, ql: string): number {
  const lower = path.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  const depth = path.split('/').length - 1;
  if (!ql) return depth;
  if (base === ql) return 0 + depth * 0.01;
  if (base.startsWith(ql)) return 10 + depth * 0.01;
  if (base.includes(ql)) return 20 + depth * 0.01;
  if (lower.startsWith(ql)) return 30 + depth * 0.01;
  if (lower.includes(ql)) return 40 + depth * 0.01;
  return 1000 + depth;
}

// ---------------------------------------------------------------------------
// Main search function — delegates to the new workspace search service
// ---------------------------------------------------------------------------

export async function searchFiles(sandboxUrl: string, query: string): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  return searchWorkspaceFilePaths(sandboxUrl, q, { limit: 20, apiLimit: 80 });
}
