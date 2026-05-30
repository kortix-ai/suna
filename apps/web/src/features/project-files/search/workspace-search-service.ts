/**
 * Workspace search service — stubbed for project-files (read-only).
 *
 * The instance feature pre-indexes the workspace via OpenCode's PTY +
 * SDK; project view has no such index, and the project files API does
 * not yet expose search. Returning empty results preserves the
 * call-shape callers expect.
 *
 * TODO: wire to project history/search once backend supports it
 */

import type { WorkspaceSearchEntry, WorkspaceSearchOptions } from './workspace-search-core';

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
