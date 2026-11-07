// Search — `GET /v1/projects/:id/search` (apps/api/src/projects/routes/project-search.ts).
//
// One query over the whole of a project's Files: names and the text of
// text-like files (the first 256 KiB of each). A person gets only what their
// folder access lets them read; a session (its own token) gets only the
// folders it may mount, also the ones that did not fit in its mount slots.
// Refusals reject with an `ApiError` (`status`, `code`): 400 `invalid_input`,
// 403 (not a project member, or `feature_disabled` with Files off), 404.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/**
 * One file or folder that matched.
 *
 * @deprecated Use `WorkspaceSearchHit`. Kept permanently.
 */
export interface ProjectSearchHit {
  /** The path in the project's Files, e.g. `/Company/plans/q3.md`. */
  path: string;
  name: string;
  kind: 'file' | 'dir';
  /** A passage of the file's text around the query's words; null for a folder or a file with no indexed text. */
  snippet: string | null;
  /** Last change (ISO 8601); null when storage did not say. */
  mtime: string | null;
  size: number;
  /** The caller's access at the path. */
  access: 'read' | 'write' | 'manage';
}

/** The workspace name of {@link ProjectSearchHit}: the same type. */
export type WorkspaceSearchHit = ProjectSearchHit;

/**
 * What `searchProject` sends.
 *
 * @deprecated Use `WorkspaceSearchInput`. Kept permanently.
 */
export interface ProjectSearchInput {
  /** 1-200 characters. Every word must match, as a prefix of a word in the name, path or text. */
  q: string;
  /** Only below this folder of the Files, e.g. `/Company`. */
  path?: string;
  /** Hits per page, 1-100 (default 20). */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  cursor?: string;
}

/** The workspace name of {@link ProjectSearchInput}: the same type. */
export type WorkspaceSearchInput = ProjectSearchInput;

/**
 * What `searchProject` resolves.
 *
 * @deprecated Use `WorkspaceSearchResult`. Kept permanently.
 */
export interface ProjectSearchResult {
  /** Name hits first, then by text rank. */
  hits: ProjectSearchHit[];
  /** Set while more hits may follow: pass it back as `cursor`. */
  next_cursor: string | null;
}

/** The workspace name of {@link ProjectSearchResult}: the same type. */
export type WorkspaceSearchResult = ProjectSearchResult;

/**
 * Search the project's Files by name and text, with the caller's folder
 * access. A file written in the last ~20 s may not be found yet. A
 * background read: a refusal rejects without an app-wide error.
 */
export async function searchWorkspace(projectId: string, input: ProjectSearchInput): Promise<ProjectSearchResult> {
  const query = new URLSearchParams({ q: input.q });
  if (input.path) query.set('path', input.path);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.cursor) query.set('cursor', input.cursor);
  return unwrap(
    await backendApi.get<ProjectSearchResult>(`/workspaces/${encodeURIComponent(projectId)}/search?${query}`, { showErrors: false }),
  );
}

/** @deprecated Use `searchWorkspace`. Kept permanently. */
export const searchProject = searchWorkspace;
