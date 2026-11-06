// Project files — list, search, read, and archive a project repo's files.

import { backendApi } from '../../http/api-client';
import { sendChecked } from '../../http/transport';
import { platformConfig } from '../../http/config';
import { type AuthenticatedRequest, authenticatedRequest } from '../../http/authenticated-request';
import { unwrap, type ProjectFileEntry } from './shared';

export async function listWorkspaceFiles(
  projectId: string,
  options?: { ref?: string; path?: string },
) {
  const params = new URLSearchParams();
  if (options?.ref) params.set('ref', options.ref);
  if (options?.path) params.set('path', options.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<ProjectFileEntry[]>(
      `/workspaces/${projectId}/files${query}`,
      // project.file.read is manager-tier — a member deep-linking to the files
      // page legitimately 403s. The files view renders its own error state.
      { showErrors: false },
    ),
  );
}

/** @deprecated Use `listWorkspaceFiles`. Kept permanently. */
export const listProjectFiles = listWorkspaceFiles;

/**
 * One entry of a folder listing: a file, or a folder to open with another call.
 *
 * @deprecated Use `WorkspaceDirectoryEntry`. Kept permanently.
 */
export interface ProjectDirectoryEntry {
  /** Repository-relative path. */
  path: string;
  type: 'file' | 'directory';
  /** Bytes of a file. A folder has none. */
  size?: number;
}

/** The workspace name of {@link ProjectDirectoryEntry}: the same type. */
export type WorkspaceDirectoryEntry = ProjectDirectoryEntry;

/** @deprecated Use `WorkspaceDirectoryListing`. Kept permanently. */
export interface ProjectDirectoryListing {
  entries: ProjectDirectoryEntry[];
  /** The folder has more entries than one response carries. */
  truncated: boolean;
  /**
   * Pass as `cursor` to read the next page. Null on the last page, and when
   * the request sent neither `cursor` nor `limit`. An API older than paging
   * omits it: loop while it is a string (`while (cursor)`), never until it
   * is `null`.
   */
  next_cursor?: string | null;
}

/** The workspace name of {@link ProjectDirectoryListing}: the same type. */
export type WorkspaceDirectoryListing = ProjectDirectoryListing;

/**
 * The immediate children of one folder (`path`, or the repository root).
 * Unlike `listProjectFiles`, which returns a recursive list cut at 1,000
 * files, every folder is complete up to its own entry cap.
 *
 * Without `cursor` or `limit`, one response carries up to 5,000 entries.
 * With either, the listing is paged: `limit` entries (1 to 2,000, default
 * 500), and `next_cursor` while entries remain. Every page reads the commit
 * the first page read, so a push between pages skips or repeats nothing.
 */
export async function listWorkspaceDirectory(
  projectId: string,
  options?: { ref?: string; path?: string; cursor?: string; limit?: number },
) {
  const params = new URLSearchParams();
  if (options?.ref) params.set('ref', options.ref);
  if (options?.path) params.set('path', options.path);
  params.set('depth', '1');
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  return unwrap(
    await backendApi.get<ProjectDirectoryListing>(
      `/workspaces/${projectId}/files?${params.toString()}`,
      // Same manager-tier gate as listProjectFiles: the view renders its own error state.
      { showErrors: false },
    ),
  );
}

/** @deprecated Use `listWorkspaceDirectory`. Kept permanently. */
export const listProjectDirectory = listWorkspaceDirectory;

/** @deprecated Use `WorkspaceFileSearchMatch`. Kept permanently. */
export interface ProjectFileSearchMatch {
  path: string;
  /** Present for content search (git grep). */
  line_number?: number;
  line_text?: string;
}

/** The workspace name of {@link ProjectFileSearchMatch}: the same type. */
export type WorkspaceFileSearchMatch = ProjectFileSearchMatch;

/** @deprecated Use `WorkspaceFileSearchResponse`. Kept permanently. */
export interface ProjectFileSearchResponse {
  query: string;
  ref: string;
  content_search: boolean;
  results: ProjectFileSearchMatch[];
}

/** The workspace name of {@link ProjectFileSearchResponse}: the same type. */
export type WorkspaceFileSearchResponse = ProjectFileSearchResponse;

/** Search the project's git repo — filenames by default, contents when
 *  `content` is true (server-side `git grep`). */
export async function searchWorkspaceFiles(
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
      `/workspaces/${projectId}/files/search?${params.toString()}`,
    ),
  );
}

/** @deprecated Use `searchWorkspaceFiles`. Kept permanently. */
export const searchProjectFiles = searchWorkspaceFiles;

export async function readWorkspaceFile(
  projectId: string,
  path: string,
  ref?: string,
) {
  const params = new URLSearchParams({ path });
  if (ref) params.set('ref', ref);
  return unwrap(
    await backendApi.get<{ path: string; ref: string; content: string; revision?: string }>(
      `/workspaces/${projectId}/files/content?${params.toString()}`,
      // Same manager-tier gate as listProjectFiles above: project.file.read
      // legitimately 403s for a plain member reading one file (e.g. a
      // skill/command detail modal, or the git-ref file explorer). Every
      // caller already renders its own inline error state, so the global
      // sink would only ever be a duplicate, unactionable toast.
      { showErrors: false },
    ),
  );
}

/** @deprecated Use `readWorkspaceFile`. Kept permanently. */
export const readProjectFile = readWorkspaceFile;

/** A large archive streams for minutes: the deadline is a hang detector, not a throughput cap. */
const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

/**
 * Fetch a binary zip archive of a project repo (or subtree) as a Blob.
 *
 * Uses the same auth as `backendApi` but bypasses its JSON-only unwrap so we
 * can stream `application/zip` directly.
 */
export async function fetchWorkspaceArchive(
  projectId: string,
  ref: string,
  path?: string,
): Promise<Blob> {
  const params = new URLSearchParams();
  if (ref) params.set('ref', ref);
  if (path) params.set('path', path);
  const query = params.toString() ? `?${params.toString()}` : '';

  const url = `${platformConfig().backendUrl || ''}/workspaces/${projectId}/files/archive${query}`;
  const res = await sendChecked(url, { method: 'GET' }, { timeoutMs: ARCHIVE_TIMEOUT_MS }, 'Failed to download');
  return await res.blob();
}

/** @deprecated Use `fetchWorkspaceArchive`. Kept permanently. */
export const fetchProjectArchive = fetchWorkspaceArchive;

/**
 * The archive download of {@link fetchWorkspaceArchive} as a request the host
 * sends itself, for a host that streams the zip to disk (React Native's
 * `FileSystem.downloadAsync`) instead of reading it into a Blob.
 */
export async function workspaceArchiveRequest(
  projectId: string,
  ref: string,
  path?: string,
): Promise<AuthenticatedRequest> {
  const params = new URLSearchParams();
  if (ref) params.set('ref', ref);
  if (path) params.set('path', path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return authenticatedRequest(
    `${platformConfig().backendUrl}/workspaces/${encodeURIComponent(projectId)}/files/archive${query}`,
  );
}

/** @deprecated Use `workspaceArchiveRequest`. Kept permanently. */
export const projectArchiveRequest = workspaceArchiveRequest;

/**
 * Fetch one project file's exact bytes at a ref.
 *
 * The JSON read (`readProjectFile`) carries `git show` stdout as a UTF-8
 * string, which corrupts every byte that is not valid UTF-8 — this is the
 * byte-accurate read the file previews and downloads need. The response is
 * always bytes; classifying text vs binary is the caller's job (the web does
 * it with the same NUL-byte heuristic the sandbox daemon uses).
 */
export async function fetchWorkspaceFileRaw(
  projectId: string,
  path: string,
  ref?: string,
  options?: { signal?: AbortSignal },
): Promise<Blob> {
  const params = new URLSearchParams({ path });
  if (ref) params.set('ref', ref);
  const query = params.toString() ? `?${params.toString()}` : '';

  const url = `${platformConfig().backendUrl || ''}/workspaces/${projectId}/files/raw${query}`;
  const res = await sendChecked(
    url,
    { method: 'GET', ...(options?.signal ? { signal: options.signal } : {}) },
    {},
    'Failed to read file',
  );
  return await res.blob();
}

/** @deprecated Use `fetchWorkspaceFileRaw`. Kept permanently. */
export const fetchProjectFileRaw = fetchWorkspaceFileRaw;

/** Commit an edited text file only if its viewed blob revision is unchanged. */
export async function writeWorkspaceFile(
  projectId: string,
  input: { path: string; ref: string; content: string; expected_revision: string },
) {
  return unwrap(await backendApi.put<{ commit_sha: string }>(
    `/workspaces/${projectId}/files/content`, input, { showErrors: false },
  ));
}

/** @deprecated Use `writeWorkspaceFile`. Kept permanently. */
export const writeProjectFile = writeWorkspaceFile;
