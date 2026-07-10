// Project files — list, search, read, and archive a project repo's files.

import { backendApi } from '../../http/api-client';
import { getSupabaseAccessTokenWithRetry } from '../../http/auth';
import { platformConfig } from '../../http/config';
import { unwrap, type ProjectFileEntry } from './shared';

export async function listProjectFiles(
  projectId: string,
  options?: { ref?: string; path?: string },
) {
  const params = new URLSearchParams();
  if (options?.ref) params.set('ref', options.ref);
  if (options?.path) params.set('path', options.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<ProjectFileEntry[]>(
      `/projects/${projectId}/files${query}`,
      // project.file.read is editor-tier — a member deep-linking to the files
      // page legitimately 403s. The files view renders its own error state.
      { showErrors: false },
    ),
  );
}

export interface ProjectFileSearchMatch {
  path: string;
  /** Present for content search (git grep). */
  line_number?: number;
  line_text?: string;
}

export interface ProjectFileSearchResponse {
  query: string;
  ref: string;
  content_search: boolean;
  results: ProjectFileSearchMatch[];
}

/** Search the project's git repo — filenames by default, contents when
 *  `content` is true (server-side `git grep`). */
export async function searchProjectFiles(
  projectId: string,
  query: string,
  options?: { content?: boolean; ref?: string; limit?: number },
) {
  const params = new URLSearchParams({ q: query });
  if (options?.content) params.set('content', '1');
  if (options?.ref) params.set('ref', options.ref);
  if (options?.limit) params.set('limit', String(options.limit));
  return unwrap(
    await backendApi.get<ProjectFileSearchResponse>(
      `/projects/${projectId}/files/search?${params.toString()}`,
    ),
  );
}

export async function readProjectFile(
  projectId: string,
  path: string,
  ref?: string,
) {
  const params = new URLSearchParams({ path });
  if (ref) params.set('ref', ref);
  return unwrap(
    await backendApi.get<{ path: string; ref: string; content: string }>(
      `/projects/${projectId}/files/content?${params.toString()}`,
    ),
  );
}

/**
 * Fetch a binary zip archive of a project repo (or subtree) as a Blob.
 *
 * Uses the same auth as `backendApi` but bypasses its JSON-only unwrap so we
 * can stream `application/zip` directly.
 */
export async function fetchProjectArchive(
  projectId: string,
  ref: string,
  path?: string,
): Promise<Blob> {
  const params = new URLSearchParams();
  if (ref) params.set('ref', ref);
  if (path) params.set('path', path);
  const query = params.toString() ? `?${params.toString()}` : '';

  const token = await getSupabaseAccessTokenWithRetry();
  const url = `${platformConfig().backendUrl || ''}/projects/${projectId}/files/archive${query}`;
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
