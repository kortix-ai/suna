// Workspace files — list, search, read, and archive a workspace repo's files.

import { backendApi } from '../../http/api-client';
import { getSupabaseAccessTokenWithRetry } from '../../http/auth';
import { platformConfig } from '../../http/config';
import { unwrap, type WorkspaceFileEntry } from './shared';

export async function listWorkspaceFiles(
  workspaceId: string,
  options?: { ref?: string; path?: string },
) {
  const params = new URLSearchParams();
  if (options?.ref) params.set('ref', options.ref);
  if (options?.path) params.set('path', options.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<WorkspaceFileEntry[]>(
      `/workspaces/${workspaceId}/files${query}`,
      // workspace.file.read is editor-tier — a member deep-linking to the files
      // page legitimately 403s. The files view renders its own error state.
      { showErrors: false },
    ),
  );
}

export interface WorkspaceFileSearchMatch {
  path: string;
  /** Present for content search (git grep). */
  line_number?: number;
  line_text?: string;
}

export interface WorkspaceFileSearchResponse {
  query: string;
  ref: string;
  content_search: boolean;
  results: WorkspaceFileSearchMatch[];
}

/** Search the workspace's git repo — filenames by default, contents when
 *  `content` is true (server-side `git grep`). */
export async function searchWorkspaceFiles(
  workspaceId: string,
  query: string,
  options?: { content?: boolean; ref?: string; limit?: number },
) {
  const params = new URLSearchParams({ q: query });
  if (options?.content) params.set('content', '1');
  if (options?.ref) params.set('ref', options.ref);
  if (options?.limit) params.set('limit', String(options.limit));
  return unwrap(
    await backendApi.get<WorkspaceFileSearchResponse>(
      `/workspaces/${workspaceId}/files/search?${params.toString()}`,
    ),
  );
}

export async function readWorkspaceFile(
  workspaceId: string,
  path: string,
  ref?: string,
) {
  const params = new URLSearchParams({ path });
  if (ref) params.set('ref', ref);
  return unwrap(
    await backendApi.get<{ path: string; ref: string; content: string }>(
      `/workspaces/${workspaceId}/files/content?${params.toString()}`,
      // Same editor-tier gate as listWorkspaceFiles above: workspace.file.read
      // legitimately 403s for a plain member reading one file (e.g. a
      // skill/command detail modal, or the git-ref file explorer). Every
      // caller already renders its own inline error state, so the global
      // sink would only ever be a duplicate, unactionable toast.
      { showErrors: false },
    ),
  );
}

/**
 * Fetch a binary zip archive of a workspace repo (or subtree) as a Blob.
 *
 * Uses the same auth as `backendApi` but bypasses its JSON-only unwrap so we
 * can stream `application/zip` directly.
 */
export async function fetchWorkspaceArchive(
  workspaceId: string,
  ref: string,
  path?: string,
): Promise<Blob> {
  const params = new URLSearchParams();
  if (ref) params.set('ref', ref);
  if (path) params.set('path', path);
  const query = params.toString() ? `?${params.toString()}` : '';

  const token = await getSupabaseAccessTokenWithRetry();
  const url = `${platformConfig().backendUrl || ''}/workspaces/${workspaceId}/files/archive${query}`;
  // lgtm[js/file-access-to-http] This method intentionally downloads the caller-selected workspace file archive.
  const res = await fetch(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to download (HTTP ${res.status})`);
  }
  return await res.blob();
}
