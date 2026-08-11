/**
 * Workspace search service — stubbed for workspace-files (read-only).
 *
 * The instance feature pre-indexes the workspace via OpenCode's PTY +
 * SDK; project view has no such index, and the workspace files API does
 * not yet expose search. Returning empty results preserves the
 * call-shape callers expect.
 *
 * TODO: wire to workspace history/search once backend supports it
 */

import type { WorkspaceSearchEntry, WorkspaceSearchOptions } from '@/features/file-browser/search/workspace-search-core';

interface WorkspaceSearchRuntimeOptions extends WorkspaceSearchOptions {
  apiLimit?: number;
}

export async function searchWorkspaceFileEntries(
  _query: string,
  _options?: WorkspaceSearchRuntimeOptions,
): Promise<WorkspaceSearchEntry[]> {
  return [];
}

export async function searchWorkspaceFilePaths(
  _query: string,
  _options?: WorkspaceSearchRuntimeOptions,
): Promise<string[]> {
  return [];
}

export async function searchWorkspaceFiles(
  _query: string,
  _limit = 50,
): Promise<string[]> {
  return [];
}
