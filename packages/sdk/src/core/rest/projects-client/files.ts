// Project files — list, search, read, and archive a project repo's files.

import { backendApi } from '../../http/api-client';
import { sendChecked } from '../../http/transport';
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
      // project.file.read is manager-tier — a member deep-linking to the files
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
      // Same manager-tier gate as listProjectFiles above: project.file.read
      // legitimately 403s for a plain member reading one file (e.g. a
      // skill/command detail modal, or the git-ref file explorer). Every
      // caller already renders its own inline error state, so the global
      // sink would only ever be a duplicate, unactionable toast.
      { showErrors: false },
    ),
  );
}

/** A large archive streams for minutes: the deadline is a hang detector, not a throughput cap. */
const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

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

  const url = `${platformConfig().backendUrl || ''}/projects/${projectId}/files/archive${query}`;
  const res = await sendChecked(url, { method: 'GET' }, { timeoutMs: ARCHIVE_TIMEOUT_MS }, 'Failed to download');
  return await res.blob();
}

/**
 * Fetch one project file's exact bytes at a ref.
 *
 * The JSON read (`readProjectFile`) carries `git show` stdout as a UTF-8
 * string, which corrupts every byte that is not valid UTF-8 — this is the
 * byte-accurate read the file previews and downloads need. The response is
 * always bytes; classifying text vs binary is the caller's job (the web does
 * it with the same NUL-byte heuristic the sandbox daemon uses).
 */
export async function fetchProjectFileRaw(
  projectId: string,
  path: string,
  ref?: string,
  options?: { signal?: AbortSignal },
): Promise<Blob> {
  const params = new URLSearchParams({ path });
  if (ref) params.set('ref', ref);
  const query = params.toString() ? `?${params.toString()}` : '';

  const token = await getSupabaseAccessTokenWithRetry();
  const url = `${platformConfig().backendUrl || ''}/projects/${projectId}/files/raw${query}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: options?.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to read file (HTTP ${res.status})`);
  }
  return await res.blob();
}
