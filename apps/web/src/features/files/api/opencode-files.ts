/**
 * OpenCode File API — filesystem access via the SDK client + kortix-master.
 *
 * Read endpoints (list, read, status, find) go through the upstream
 * `@kortix/sdk/opencode-client` client singleton which proxies to OpenCode.
 *
 * Write endpoints (upload, delete, mkdir, rename) and binary downloads
 * use `authenticatedFetch()` to hit kortix-master's /file/* routes
 * directly, since the upstream SDK has no write methods.
 */

import { getClient } from '@/lib/opencode-sdk';
import { getActiveOpenCodeUrl } from '@/stores/server-store';
import { getAuthToken, authenticatedFetch } from '@/lib/auth-token';
import JSZip from 'jszip';
import type {
  FileContent,
  FileNode,
  FindMatch,
  GitFileStatus,
  OpenCodeProjectInfo,
  ServerHealth,
} from '../types';

// ---------------------------------------------------------------------------
// Helper: unwrap SDK response (data / error)
// ---------------------------------------------------------------------------

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) {
    const err = result.error as any;
    // Server error responses may use { error: '...' }, { message: '...' }, or { data: { message: '...' } }
    const message =
      err?.data?.message ||
      err?.message ||
      (typeof err?.error === 'string' ? err.error : null) ||
      'SDK request failed';
    throw new Error(message);
  }
  return result.data as T;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * GET a daemon JSON endpoint (list / status / find) via authenticatedFetch,
 * surfacing the server's error message on non-2xx. The daemon owns these
 * routes; we no longer go through the OpenCode SDK for file ops.
 */
async function fetchDaemonJson<T>(relUrl: string): Promise<T> {
  const baseUrl = getActiveOpenCodeUrl();
  const response = await authenticatedFetch(`${baseUrl}${relUrl}`);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const message = parsed?.error || text || response.statusText || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

/**
 * List files and directories at a given path.
 *
 * The daemon's `GET /file` resolves `path` RELATIVE to the worktree (/workspace),
 * so we strip the workspace prefix to a repo-relative path (root → ".") for the
 * request, then map the repo-relative results back onto the absolute
 * "/workspace/..." form the rest of the app navigates and reads with.
 */
export async function listFiles(dirPath: string): Promise<FileNode[]> {
  const rel = toWorkspaceRelative(dirPath) || '.';
  const nodes = await fetchDaemonJson<FileNode[]>(`/file?path=${encodeURIComponent(rel)}`);
  return nodes.map((node) => ({
    ...node,
    path: node.absolute || `/workspace/${node.path}`,
  }));
}

/**
 * Strip the "/workspace" prefix down to a worktree-relative path ("" = root).
 * The daemon's read/list endpoints resolve `path` relative to the worktree.
 */
function toWorkspaceRelative(filePath: string): string {
  let s = filePath || '';
  if (s === '/workspace' || s === '/workspace/') return '';
  if (s.startsWith('/workspace/')) s = s.slice('/workspace/'.length);
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

/**
 * Read the content of a file.
 * Returns text content for text files, base64-encoded content for images/binaries.
 *
 * Uses authenticatedFetch directly (bypassing the SDK) so we can inspect the
 * HTTP status code and throw a clear error for 404 / non-existent files.
 */
export async function readFile(filePath: string): Promise<FileContent> {
  const baseUrl = getActiveOpenCodeUrl();
  // /file/content (opencode) resolves `path` RELATIVE to the worktree
  // (/workspace) — exactly like file.list. Passing the absolute "/workspace/..."
  // makes it read "/workspace/workspace/..." and return 200 with EMPTY content,
  // so the preview shows a blank file. Send a worktree-relative path instead.
  // (readFileAsBlob also goes through here — binary files come back base64.)
  const relativePath = toWorkspaceRelative(filePath);
  const url = `${baseUrl}/file/content?path=${encodeURIComponent(relativePath)}`;
  const response = await authenticatedFetch(url);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const message = parsed?.error || text || response.statusText || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return response.json() as Promise<FileContent>;
}

// ---------------------------------------------------------------------------
// Binary helpers — fetch file bytes and trigger download
// ---------------------------------------------------------------------------

/**
 * Fetch a file as a Blob (downloads + binary previews — PDF, Office docs, video,
 * audio, images, sqlite, …).
 *
 * Prefers the daemon's `GET /file/raw` byte stream — correct and efficient for
 * ALL types (no base64 bloat over the wire). If `/file/raw` is unavailable
 * (e.g. an older sandbox image whose daemon predates it) we fall back to the
 * JSON `/file/content` endpoint, which the daemon also serves correctly
 * (base64 for binary). `readFileRaw` guards against the SPA-shell-as-bytes trap
 * by rejecting `text/html` responses, so a misroute degrades to the fallback
 * rather than returning a corrupt blob.
 */
export async function readFileAsBlob(filePath: string): Promise<Blob> {
  try {
    return await readFileRaw(filePath);
  } catch {
    // Fall back to the JSON content endpoint (also daemon-served, correct).
  }
  const result = await readFile(filePath);
  if (result.encoding === 'base64' && result.content) {
    const bytes = Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0));
    return new Blob([bytes], {
      type: result.mimeType || 'application/octet-stream',
    });
  }
  // Text content (no base64 encoding) — return as a text blob.
  return new Blob([result.content ?? ''], {
    type: result.mimeType || 'text/plain;charset=utf-8',
  });
}

/**
 * Fetch a file's raw bytes from the daemon's direct-filesystem read route
 * (`GET /file/raw`) — the canonical byte source for downloads/previews. Sends
 * the same worktree-relative path `readFile()` uses. Throws (so the caller can
 * fall back) when the route is unavailable or returns the SPA shell.
 */
async function readFileRaw(filePath: string, fallbackMime?: string): Promise<Blob> {
  const baseUrl = getActiveOpenCodeUrl();
  const relativePath = toWorkspaceRelative(filePath);
  const url = `${baseUrl}/file/raw?path=${encodeURIComponent(relativePath)}`;
  const response = await authenticatedFetch(url);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const message = parsed?.error || text || response.statusText || `HTTP ${response.status}`;
    throw new Error(message);
  }

  // A misrouted /file/raw can fall through to the web SPA shell (HTTP 200,
  // text/html). Never hand that back as file bytes — it'd be a corrupt blob.
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error('File could not be loaded (raw byte route unavailable)');
  }

  const blob = await response.blob();
  // Prefer the mime opencode reported when the daemon couldn't infer one.
  if (fallbackMime && (!blob.type || blob.type === 'application/octet-stream')) {
    return new Blob([blob], { type: fallbackMime });
  }
  return blob;
}

/**
 * Download a file from the project to the user's machine.
 * Fetches via readFileAsBlob() and triggers a browser download.
 */
export async function downloadFile(
  filePath: string,
  fileName?: string,
): Promise<void> {
  const blob = await readFileAsBlob(filePath);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || filePath.split('/').pop() || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Recursively list all files under a directory path.
 * Returns flat array of absolute file paths.
 */
async function listAllFilesRecursive(dirPath: string): Promise<string[]> {
  const entries = await listFiles(dirPath);
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'file') {
      results.push(entry.path);
    } else if (entry.type === 'directory') {
      const nested = await listAllFilesRecursive(entry.path);
      results.push(...nested);
    }
  }
  return results;
}

/**
 * Download a directory as a zip file.
 * Recursively collects all files, bundles them with JSZip, and triggers download.
 *
 * @param dirPath - Absolute or relative path to the directory
 * @param dirName - Name to use for the downloaded .zip file (defaults to directory name)
 * @param onProgress - Optional callback with progress (0-1)
 */
export async function downloadDirectory(
  dirPath: string,
  dirName?: string,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const zip = new JSZip();
  const name = dirName || dirPath.split('/').filter(Boolean).pop() || 'directory';

  // Collect all file paths recursively
  const allFiles = await listAllFilesRecursive(dirPath);

  if (allFiles.length === 0) {
    // Empty directory — create an empty zip with a placeholder
    zip.file('.gitkeep', '');
  } else {
    // Fetch each file and add to zip, preserving relative structure
    let done = 0;
    for (const filePath of allFiles) {
      // Make the path relative to the parent of dirPath
      const relativePath = filePath.startsWith(dirPath + '/')
        ? filePath.slice(dirPath.length + 1)
        : filePath.split('/').pop() || filePath;

      const blob = await readFileAsBlob(filePath);
      zip.file(relativePath, blob);

      done++;
      if (onProgress) onProgress(done / allFiles.length);
    }
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// File mutations (write operations)
// ---------------------------------------------------------------------------

/** Response from the upload endpoint. */
export interface UploadResult {
  path: string;
  size: number;
}

const UPLOAD_RETRY_DELAYS_MS = [400, 1200];

function isTransientUploadStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }

  const jsonMessage = parsed?.error || parsed?.message || parsed?.data?.message;
  if (typeof jsonMessage === 'string' && jsonMessage.trim()) return jsonMessage.trim();

  const contentType = res.headers.get('content-type') || '';
  const htmlTitle = text
    .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim();
  if (contentType.includes('text/html') || /<html[\s>]/i.test(text)) {
    const gateway = res.status === 502 || /bad gateway/i.test(text);
    if (gateway) return 'Bad gateway while reaching the sandbox upload service. Please retry.';
    return htmlTitle || res.statusText || `HTTP ${res.status}`;
  }

  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.slice(0, 500) || res.statusText || `HTTP ${res.status}`;
}

async function uploadWithRetry(
  buildForm: () => FormData,
  send: (form: FormData) => Promise<Response>,
): Promise<UploadResult[]> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= UPLOAD_RETRY_DELAYS_MS.length; attempt++) {
    let res: Response;
    try {
      res = await send(buildForm());
    } catch (err) {
      lastError = err;
      if (attempt === UPLOAD_RETRY_DELAYS_MS.length) break;
      await sleep(UPLOAD_RETRY_DELAYS_MS[attempt]);
      continue;
    }

    if (res.ok) return res.json();

    const message = await uploadErrorMessage(res);
    lastError = new Error(`Upload failed (${res.status}): ${message}`);
    if (!isTransientUploadStatus(res.status) || attempt === UPLOAD_RETRY_DELAYS_MS.length) {
      throw lastError;
    }
    await sleep(UPLOAD_RETRY_DELAYS_MS[attempt]);
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError || 'request failed');
  throw new Error(`Upload failed: ${message}`);
}

/**
 * Upload a file to the project.
 *
 * @param file - The file or blob to upload
 * @param targetPath - Optional target directory (relative to project root)
 */
export async function uploadFile(
  file: File | Blob,
  targetPath?: string,
  filename?: string,
): Promise<UploadResult[]> {
  const baseUrl = getActiveOpenCodeUrl();

  return uploadWithRetry(
    () => {
      const form = new FormData();
      const rawPath = (targetPath ?? '').trim();
      if (rawPath) {
        const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
        form.append('path', normalizedPath);
      }
      if (filename) form.append('file', file, filename);
      else form.append('file', file);
      return form;
    },
    (form) =>
      authenticatedFetch(`${baseUrl}/file/upload`, {
        method: 'POST',
        body: form,
      }),
  );
}

/**
 * Delete a file or directory (recursively).
 */
export async function deleteFile(filePath: string): Promise<boolean> {
  const baseUrl = getActiveOpenCodeUrl();
  const res = await authenticatedFetch(`${baseUrl}/file`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Delete failed (${res.status}): ${text || res.statusText}`);
  }

  return res.json();
}

/**
 * Create a directory (recursive, idempotent).
 */
export async function mkdirFile(dirPath: string): Promise<boolean> {
  const baseUrl = getActiveOpenCodeUrl();
  const res = await authenticatedFetch(`${baseUrl}/file/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mkdir failed (${res.status}): ${text || res.statusText}`);
  }

  return res.json();
}

/**
 * Upload a file to a specific path using the field-name-as-path convention.
 *
 * Sets the FormData field name to the desired relative path so
 * kortix-master's /file/upload endpoint places it correctly.
 */
async function uploadToPath(
  filePath: string,
  content: Blob,
): Promise<UploadResult[]> {
  const baseUrl = getActiveOpenCodeUrl();

  return uploadWithRetry(
    () => {
      const form = new FormData();
      const fileName = filePath.split('/').pop() || 'file';
      form.append(filePath, content, fileName);
      return form;
    },
    async (form) => {
      const headers: Record<string, string> = {};
      const token = await getAuthToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      return fetch(`${baseUrl}/file/upload`, {
        method: 'POST',
        body: form,
        headers,
      });
    },
  );
}

/**
 * Create an empty file at the given path.
 *
 * Uses the SDK's uploadFile with a proper File object and target directory
 * so the server receives a named file entry it can place correctly.
 */
export async function createFile(filePath: string): Promise<UploadResult[]> {
  const rawPath = filePath.trim();
  const absolutePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const parts = absolutePath.split('/');
  const fileName = parts.pop() || 'untitled';
  const dirPath = parts.join('/') || '/workspace';
  const file = new File([' '], fileName, { type: 'application/octet-stream' });
  return uploadFile(file, dirPath);
}

/**
 * Copy a file from one location to another.
 * Reads the source file and uploads it to the destination.
 */
export async function copyFile(
  sourcePath: string,
  destPath: string,
): Promise<UploadResult[]> {
  const content = await readFileAsBlob(sourcePath);
  return uploadToPath(destPath, content);
}

/**
 * Rename or move a file/directory.
 */
export async function renameFile(from: string, to: string): Promise<boolean> {
  const baseUrl = getActiveOpenCodeUrl();
  const res = await authenticatedFetch(`${baseUrl}/file/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Rename failed (${res.status}): ${text || res.statusText}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Git status
// ---------------------------------------------------------------------------

/**
 * Get git file status — lists files with uncommitted changes.
 * Daemon `GET /file/status` (was OpenCode `file.status`).
 */
export async function getFileStatus(): Promise<GitFileStatus[]> {
  return fetchDaemonJson<GitFileStatus[]>(`/file/status`);
}

// ---------------------------------------------------------------------------
// Search operations
// ---------------------------------------------------------------------------

/**
 * Find files and directories by name (fuzzy match).
 * Daemon `GET /find/file` (was OpenCode `find.files`).
 */
export async function findFiles(
  query: string,
  options?: { type?: 'file' | 'directory'; limit?: number },
): Promise<string[]> {
  try {
    const params = new URLSearchParams({ query });
    if (options?.type) params.set('type', options.type);
    if (options?.limit) params.set('limit', String(options.limit));
    return await fetchDaemonJson<string[]>(`/find/file?${params.toString()}`);
  } catch {
    return [];
  }
}

/**
 * Search for text patterns across project files (ripgrep).
 * Daemon `GET /find` (was OpenCode `find.text`). The mapping tolerates both the
 * flat shape the daemon returns and the nested ripgrep-JSON shape.
 */
export async function findText(pattern: string): Promise<FindMatch[]> {
  const raw = await fetchDaemonJson<any[]>(`/find?pattern=${encodeURIComponent(pattern)}`);
  return raw.map((item) => ({
    path: typeof item.path === 'string' ? item.path : (item.path?.text ?? ''),
    lines:
      typeof item.lines === 'string' ? item.lines : (item.lines?.text ?? ''),
    line_number: item.line_number,
    absolute_offset: item.absolute_offset,
    submatches: (item.submatches ?? []).map((s: any) => ({
      start: s.start,
      end: s.end,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Project / server info
// ---------------------------------------------------------------------------

/**
 * Get current project information.
 */
export async function getCurrentProject(): Promise<OpenCodeProjectInfo> {
  const client = getClient();
  const result = await client.project.current();
  return unwrap(result) as OpenCodeProjectInfo;
}

/**
 * Server health check.
 */
export async function getServerHealth(): Promise<ServerHealth> {
  const client = getClient();
  const result = await client.global.health();
  return unwrap(result) as ServerHealth;
}

/**
 * Check if the OpenCode server is reachable.
 * Returns true/false without throwing.
 */
export async function isServerReachable(): Promise<boolean> {
  try {
    const health = await getServerHealth();
    return health.healthy === true;
  } catch {
    return false;
  }
}
