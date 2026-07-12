/**
 * Workspace file client — the daemon `/file` + `/find` data operations, owned by
 * the SDK. The host never calls `authenticatedFetch('/file/...')` itself.
 *
 * Read (list/content/status/find) and write (upload/delete/mkdir/rename) all hit
 * the in-sandbox daemon for the active server; project/health go through the
 * opencode client. DOM-bound helpers (download / zip) stay in the host UI and
 * consume `readBlob`/`list` from here.
 */
import { getClient } from '../runtime/client';
import { getActiveRuntimeUrl } from '../session/server-store/active';
import { getAuthToken, authenticatedFetch } from '../http/auth';
import { ApiError } from '../http/api/errors';
import type {
  FileContent,
  FileNode,
  FindMatch,
  GitFileStatus,
  RuntimeProjectInfo,
  ServerHealth,
  UploadResult,
} from './types';

// Re-export the file types from the `@kortix/sdk/files` subpath too, so hosts can
// import both the ops and the types from one place.
export type * from './types';

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) {
    const err = result.error as {
      data?: { message?: string };
      message?: string;
      error?: unknown;
      response?: Response;
      status?: number;
    };
    const message =
      err?.data?.message ||
      err?.message ||
      (typeof err?.error === 'string' ? err.error : null) ||
      'SDK request failed';
    throw new ApiError(message, {
      status: err?.response?.status ?? err?.status,
      response: err?.response,
      details: err,
    });
  }
  return result.data as T;
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  let parsed: { error?: string } | null = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return parsed?.error || text || res.statusText || `HTTP ${res.status}`;
}

/**
 * GET a daemon JSON endpoint (list/status/find), surfacing the server's error.
 * `baseUrl` defaults to the module-global "active" sandbox for back-compat —
 * pass an explicit one (e.g. from `kortix.session(pid, sid).files`) to hit a
 * SPECIFIC session's own runtime instead.
 */
async function fetchDaemonJson<T>(relUrl: string, baseUrl: string = getActiveRuntimeUrl()): Promise<T> {
  const response = await authenticatedFetch(`${baseUrl}${relUrl}`);
  if (!response.ok) {
    throw new ApiError(await errorMessage(response), { status: response.status, response });
  }
  return response.json() as Promise<T>;
}

/**
 * Sandbox filesystem roots the daemon serves (mirrors DEFAULT_ALLOWED_ROOTS in
 * kortix-sandbox-agent-server). The daemon re-validates every path server-side;
 * this mirror only keeps hosts from mangling non-workspace paths client-side.
 */
export const SANDBOX_FS_ROOTS = ['/workspace', '/tmp', '/home', '/opt'] as const;

const NON_WORKSPACE_ROOTS = SANDBOX_FS_ROOTS.filter((root) => root !== '/workspace');

/** Whether a path is absolute under one of the daemon's allowed roots. */
export function isUnderSandboxRoot(filePath: string): boolean {
  return SANDBOX_FS_ROOTS.some((root) => filePath === root || filePath.startsWith(`${root}/`));
}

/**
 * Resolve any host path to an absolute sandbox path — paths already under an
 * allowed root pass through, everything else anchors beneath /workspace.
 */
export function toSandboxAbsolutePath(filePath: string): string {
  if (isUnderSandboxRoot(filePath)) return filePath;
  return `/workspace/${filePath.replace(/^\/+/, '')}`;
}

/**
 * Convert a host path to the daemon query path. /workspace paths become
 * worktree-relative ("" = root); the other allowed roots (/tmp, /home, /opt)
 * stay absolute — the daemon resolves absolutes against its own allow-list.
 * Any other absolute path keeps the legacy leading-slash strip, so
 * "/README.md"-style pseudo-relative paths still resolve under /workspace.
 */
export function toDaemonPath(filePath: string): string {
  let s = filePath || '';
  if (s === '/workspace' || s === '/workspace/') return '';
  if (s.startsWith('/workspace/')) s = s.slice('/workspace/'.length);
  else if (NON_WORKSPACE_ROOTS.some((root) => s === root || s.startsWith(`${root}/`))) return s;
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

/** @deprecated Use {@link toDaemonPath} — non-workspace roots now pass through absolute. */
export const toWorkspaceRelative = toDaemonPath;

/**
 * List files/directories at a path. Daemon `GET /file`. `baseUrl` defaults to
 * the module-global "active" sandbox; pass one explicitly to target a
 * specific session's runtime (see `kortix.session(pid, sid).files`).
 */
export async function listFiles(dirPath: string, baseUrl: string = getActiveRuntimeUrl()): Promise<FileNode[]> {
  const daemonPath = toDaemonPath(dirPath) || '.';
  const nodes = await fetchDaemonJson<FileNode[]>(`/file?path=${encodeURIComponent(daemonPath)}`, baseUrl);
  return nodes.map((node) => ({ ...node, path: node.absolute || `/workspace/${node.path}` }));
}

/** Read a file's content (text, or base64 for binaries). Daemon `GET /file/content`. */
export async function readFile(filePath: string, baseUrl: string = getActiveRuntimeUrl()): Promise<FileContent> {
  const daemonPath = toDaemonPath(filePath);
  const response = await authenticatedFetch(`${baseUrl}/file/content?path=${encodeURIComponent(daemonPath)}`);
  if (!response.ok) {
    throw new ApiError(await errorMessage(response), { status: response.status, response });
  }
  return response.json() as Promise<FileContent>;
}

/** Raw byte read. Daemon `GET /file/raw`. Throws (so callers can fall back). */
async function readFileRaw(filePath: string, fallbackMime?: string, baseUrl: string = getActiveRuntimeUrl()): Promise<Blob> {
  const daemonPath = toDaemonPath(filePath);
  const response = await authenticatedFetch(`${baseUrl}/file/raw?path=${encodeURIComponent(daemonPath)}`);
  if (!response.ok) {
    throw new ApiError(await errorMessage(response), { status: response.status, response });
  }
  // A misrouted /file/raw can fall through to the web SPA shell (200, text/html).
  if ((response.headers.get('content-type') || '').includes('text/html')) {
    throw new ApiError('File could not be loaded (raw byte route unavailable)', {
      status: response.status,
      response,
      code: 'INVALID_CONTENT_TYPE',
    });
  }
  const blob = await response.blob();
  if (fallbackMime && (!blob.type || blob.type === 'application/octet-stream')) {
    return new Blob([blob], { type: fallbackMime });
  }
  return blob;
}

/** Read a file as a Blob — prefers `/file/raw`, falls back to base64 `/file/content`. */
export async function readBlob(filePath: string, baseUrl: string = getActiveRuntimeUrl()): Promise<Blob> {
  try {
    return await readFileRaw(filePath, undefined, baseUrl);
  } catch { /* fall back to JSON content endpoint */ }
  const result = await readFile(filePath, baseUrl);
  if (result.encoding === 'base64' && result.content) {
    const bytes = Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: result.mimeType || 'application/octet-stream' });
  }
  return new Blob([result.content ?? ''], { type: result.mimeType || 'text/plain;charset=utf-8' });
}

/** Git file status — uncommitted changes. Daemon `GET /file/status`. */
export function getFileStatus(baseUrl: string = getActiveRuntimeUrl()): Promise<GitFileStatus[]> {
  return fetchDaemonJson<GitFileStatus[]>(`/file/status`, baseUrl);
}

/**
 * Find files/directories by name (fuzzy). Daemon `GET /find/file`.
 *
 * Throws `ApiError` on failure — like every other op in this module. This
 * USED TO swallow every failure to `[]`, which silently hid daemon/network
 * errors from callers. The only real caller of this SDK export
 * (`apps/web/src/features/files/search/workspace-search-service.ts`) already
 * wraps each call in its own `.catch(() => [])`, and there are no callers
 * under `@kortix/sdk/react`, so removing the internal swallow here is
 * non-breaking — verified by grepping every `findFiles(` call site in the
 * monorepo before making this change.
 */
export async function findFiles(
  query: string,
  options?: { type?: 'file' | 'directory'; limit?: number },
  baseUrl: string = getActiveRuntimeUrl(),
): Promise<string[]> {
  const params = new URLSearchParams({ query });
  if (options?.type) params.set('type', options.type);
  if (options?.limit) params.set('limit', String(options.limit));
  return fetchDaemonJson<string[]>(`/find/file?${params.toString()}`, baseUrl);
}

/** Ripgrep text search. Daemon `GET /find`. Tolerates flat + nested rg-JSON. */
export async function findText(pattern: string, baseUrl: string = getActiveRuntimeUrl()): Promise<FindMatch[]> {
  const raw = await fetchDaemonJson<Array<Record<string, any>>>(`/find?pattern=${encodeURIComponent(pattern)}`, baseUrl);
  return raw.map((item) => ({
    path: typeof item.path === 'string' ? item.path : (item.path?.text ?? ''),
    lines: typeof item.lines === 'string' ? item.lines : (item.lines?.text ?? ''),
    line_number: item.line_number,
    absolute_offset: item.absolute_offset,
    submatches: (item.submatches ?? []).map((s: { start: number; end: number }) => ({ start: s.start, end: s.end })),
  }));
}

// ── writes ───────────────────────────────────────────────────────────────────
const UPLOAD_RETRY_DELAYS_MS = [400, 1200];
const isTransient = (s: number) => s === 408 || s === 429 || s === 502 || s === 503 || s === 504;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function uploadErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  let parsed: { error?: string; message?: string; data?: { message?: string } } | null = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  const jsonMessage = parsed?.error || parsed?.message || parsed?.data?.message;
  if (typeof jsonMessage === 'string' && jsonMessage.trim()) return jsonMessage.trim();
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html') || /<html[\s>]/i.test(text)) {
    if (res.status === 502 || /bad gateway/i.test(text)) return 'Bad gateway while reaching the sandbox upload service. Please retry.';
    return res.statusText || `HTTP ${res.status}`;
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 500) || res.statusText || `HTTP ${res.status}`;
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
    lastError = new ApiError(`Upload failed (${res.status}): ${message}`, { status: res.status, response: res });
    if (!isTransient(res.status) || attempt === UPLOAD_RETRY_DELAYS_MS.length) throw lastError;
    await sleep(UPLOAD_RETRY_DELAYS_MS[attempt]);
  }
  if (lastError instanceof ApiError) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError || 'request failed');
  throw new ApiError(`Upload failed: ${message}`);
}

/**
 * Upload a file. Daemon `POST /file/upload`. `baseUrl` defaults to the
 * module-global "active" sandbox; pass one explicitly to target a specific
 * session's runtime.
 */
export function uploadFile(
  file: File | Blob,
  targetPath?: string,
  filename?: string,
  baseUrl: string = getActiveRuntimeUrl(),
): Promise<UploadResult[]> {
  return uploadWithRetry(
    () => {
      const form = new FormData();
      const rawPath = (targetPath ?? '').trim();
      if (rawPath) form.append('path', rawPath.startsWith('/') ? rawPath : `/${rawPath}`);
      if (filename) form.append('file', file, filename);
      else form.append('file', file);
      return form;
    },
    (form) => authenticatedFetch(`${baseUrl}/file/upload`, { method: 'POST', body: form }),
  );
}

/** Upload content to a specific path via the field-name-as-path convention. */
function uploadToPath(filePath: string, content: Blob, baseUrl: string = getActiveRuntimeUrl()): Promise<UploadResult[]> {
  return uploadWithRetry(
    () => {
      const form = new FormData();
      form.append(filePath, content, filePath.split('/').pop() || 'file');
      return form;
    },
    async (form) => {
      const headers: Record<string, string> = {};
      const token = await getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return fetch(`${baseUrl}/file/upload`, { method: 'POST', body: form, headers });
    },
  );
}

/** Create an empty file at a path. */
export function createFile(filePath: string, baseUrl: string = getActiveRuntimeUrl()): Promise<UploadResult[]> {
  const rawPath = filePath.trim();
  const absolutePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const parts = absolutePath.split('/');
  const fileName = parts.pop() || 'untitled';
  const dirPath = parts.join('/') || '/workspace';
  return uploadFile(new File([' '], fileName, { type: 'application/octet-stream' }), dirPath, undefined, baseUrl);
}

/** Copy a file (read source bytes → upload to dest). */
export async function copyFile(sourcePath: string, destPath: string, baseUrl: string = getActiveRuntimeUrl()): Promise<UploadResult[]> {
  return uploadToPath(destPath, await readBlob(sourcePath, baseUrl), baseUrl);
}

/** Delete a file/dir (recursive). Daemon `DELETE /file`. */
export async function deleteFile(filePath: string, baseUrl: string = getActiveRuntimeUrl()): Promise<boolean> {
  const res = await authenticatedFetch(`${baseUrl}/file`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });
  if (!res.ok) {
    throw new ApiError(`Delete failed (${res.status}): ${await errorMessage(res)}`, { status: res.status, response: res });
  }
  return res.json();
}

/** Create a directory (recursive, idempotent). Daemon `POST /file/mkdir`. */
export async function mkdir(dirPath: string, baseUrl: string = getActiveRuntimeUrl()): Promise<boolean> {
  const res = await authenticatedFetch(`${baseUrl}/file/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) {
    throw new ApiError(`Mkdir failed (${res.status}): ${await errorMessage(res)}`, { status: res.status, response: res });
  }
  return res.json();
}

/** Rename/move a file or directory. Daemon `POST /file/rename`. */
export async function renameFile(from: string, to: string, baseUrl: string = getActiveRuntimeUrl()): Promise<boolean> {
  const res = await authenticatedFetch(`${baseUrl}/file/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    throw new ApiError(`Rename failed (${res.status}): ${await errorMessage(res)}`, { status: res.status, response: res });
  }
  return res.json();
}

// ── project / health (via opencode client) ────────────────────────────────────
export async function getCurrentProject(): Promise<RuntimeProjectInfo> {
  return unwrap(await getClient().project.current()) as RuntimeProjectInfo;
}

export async function getServerHealth(): Promise<ServerHealth> {
  return unwrap(await getClient().global.health()) as ServerHealth;
}

export async function isServerReachable(): Promise<boolean> {
  try {
    return (await getServerHealth()).healthy === true;
  } catch {
    return false;
  }
}

/** Grouped namespace for ergonomic use (also available as named exports). */
export const files = {
  list: listFiles,
  read: readFile,
  readBlob,
  status: getFileStatus,
  findFiles,
  findText,
  upload: uploadFile,
  create: createFile,
  copy: copyFile,
  remove: deleteFile,
  mkdir,
  rename: renameFile,
  currentProject: getCurrentProject,
  health: getServerHealth,
  isReachable: isServerReachable,
  toDaemonPath,
  toSandboxAbsolutePath,
  toWorkspaceRelative,
};
