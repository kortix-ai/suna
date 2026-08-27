/**
 * Workspace file client — the daemon `/file` + `/find` data operations, owned by
 * the SDK. The host never calls `authenticatedFetch('/file/...')` itself.
 *
 * Read (list/content/status/find) and write (upload/delete/mkdir/rename) all hit
 * the in-sandbox daemon for the active server; project/health go through the
 * opencode client. DOM-bound helpers (download / zip) stay in the host UI and
 * consume `readBlob`/`list` from here.
 */
import { getClient, RuntimeNotReadyError } from '../runtime/client';
import { getActiveOpenCodeUrl } from '../session/server-store/active';
import { authenticatedFetch } from '../http/auth';
import { ApiError } from '../http/api/errors';
import type {
  FileContent,
  FileNode,
  FindMatch,
  GitFileStatus,
  OpenCodeProjectInfo,
  ServerHealth,
  UploadResult,
  WriteFileResult,
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
 * Resolve the daemon base url for ONE operation — or refuse to run it.
 *
 * `getActiveOpenCodeUrl()` returns `''` on a billing-enabled deployment until a
 * session runtime is bound (`session/server-store/active.ts`). Interpolating
 * that `''` into a template makes the request URL RELATIVE, so the browser sent
 * the user's file AND their bearer token to the WEB origin
 * (`https://dev.kortix.com/file/upload`), which answered with the Next.js 404
 * HTML shell — surfacing as "Upload failed (404): Not Found".
 *
 * The send path already refuses this race (`runtime/client.ts` `getClient()`
 * throws `RuntimeNotReadyError`); the files transport now refuses it the same
 * way, with the same error class, so a host can classify both with one
 * `instanceof` and retry once the session is ready. An explicitly-passed empty
 * string is refused too — a caller that hands us a blank base url has the same
 * unresolved runtime, and falling back to the module-global would silently
 * target a DIFFERENT session's sandbox.
 *
 * Every operation in this module goes through here. A relative-URL fetch must
 * be impossible from this file.
 */
function requireBaseUrl(baseUrl?: string): string {
  const resolved = (baseUrl ?? getActiveOpenCodeUrl()).trim();
  if (!resolved) throw new RuntimeNotReadyError();
  return resolved;
}

/**
 * GET a daemon JSON endpoint (list/status/find), surfacing the server's error.
 * `baseUrl` defaults to the module-global "active" sandbox for back-compat —
 * pass an explicit one (e.g. from `kortix.session(pid, sid).files`) to hit a
 * SPECIFIC session's own runtime instead.
 */
async function fetchDaemonJson<T>(relUrl: string, baseUrl?: string): Promise<T> {
  const response = await authenticatedFetch(`${requireBaseUrl(baseUrl)}${relUrl}`);
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
export async function listFiles(dirPath: string, baseUrl?: string): Promise<FileNode[]> {
  const base = requireBaseUrl(baseUrl);
  const daemonPath = toDaemonPath(dirPath) || '.';
  const nodes = await fetchDaemonJson<FileNode[]>(`/file?path=${encodeURIComponent(daemonPath)}`, base);
  return nodes.map((node) => ({ ...node, path: node.absolute || `/workspace/${node.path}` }));
}

/** Read a file's content (text, or base64 for binaries). Daemon `GET /file/content`. */
export async function readFile(filePath: string, baseUrl?: string): Promise<FileContent> {
  const base = requireBaseUrl(baseUrl);
  const daemonPath = toDaemonPath(filePath);
  const response = await authenticatedFetch(`${base}/file/content?path=${encodeURIComponent(daemonPath)}`);
  if (!response.ok) {
    throw new ApiError(await errorMessage(response), { status: response.status, response });
  }
  return response.json() as Promise<FileContent>;
}

/** Raw byte read. Daemon `GET /file/raw`. Throws (so callers can fall back). */
async function readFileRaw(filePath: string, fallbackMime?: string, baseUrl?: string): Promise<Blob> {
  const base = requireBaseUrl(baseUrl);
  const daemonPath = toDaemonPath(filePath);
  const response = await authenticatedFetch(`${base}/file/raw?path=${encodeURIComponent(daemonPath)}`);
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
export async function readBlob(filePath: string, baseUrl?: string): Promise<Blob> {
  // Resolve BEFORE the try: an unresolved runtime must surface as
  // `RuntimeNotReadyError`, not be swallowed into the base64 fallback path.
  const base = requireBaseUrl(baseUrl);
  try {
    return await readFileRaw(filePath, undefined, base);
  } catch { /* fall back to JSON content endpoint */ }
  const result = await readFile(filePath, base);
  if (result.encoding === 'base64' && result.content) {
    const bytes = Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: result.mimeType || 'application/octet-stream' });
  }
  return new Blob([result.content ?? ''], { type: result.mimeType || 'text/plain;charset=utf-8' });
}

/** Git file status — uncommitted changes. Daemon `GET /file/status`. */
export async function getFileStatus(baseUrl?: string): Promise<GitFileStatus[]> {
  return fetchDaemonJson<GitFileStatus[]>(`/file/status`, requireBaseUrl(baseUrl));
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
  baseUrl?: string,
): Promise<string[]> {
  const base = requireBaseUrl(baseUrl);
  const params = new URLSearchParams({ query });
  if (options?.type) params.set('type', options.type);
  if (options?.limit) params.set('limit', String(options.limit));
  return fetchDaemonJson<string[]>(`/find/file?${params.toString()}`, base);
}

/** Ripgrep text search. Daemon `GET /find`. Tolerates flat + nested rg-JSON. */
export async function findText(pattern: string, baseUrl?: string): Promise<FindMatch[]> {
  const base = requireBaseUrl(baseUrl);
  const raw = await fetchDaemonJson<Array<Record<string, any>>>(`/find?pattern=${encodeURIComponent(pattern)}`, base);
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

/**
 * A thrown request that retrying cannot fix.
 *
 * The status path has always discriminated (see `isTransient`); the throw path
 * did not, and retried everything. So a body too large for the deadline blew
 * that same deadline on all three attempts, and the caller waited roughly three
 * times the timeout to be told `Upload failed: signal timed out`. Re-sending an
 * identical body against an identical budget cannot succeed — the only thing
 * the retries bought was a longer wait for the same answer.
 *
 * `TimeoutError` is what `AbortSignal.timeout()` raises; `AbortError` is a
 * caller cancelling on purpose, which must never be "retried" back to life.
 */
function isUnretryableThrow(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** The floor for any upload — the platform-wide default request deadline. */
const UPLOAD_TIMEOUT_FLOOR_MS = 30_000;
/**
 * The ceiling. A stuck upload must not wedge a server-side handler forever.
 *
 * It is NOT the API proxy's budget, and must not be clamped down to it. The
 * proxy's `PROXY_RETRY_BUDGET_MS` (50s, `apps/api/src/sandbox-proxy/`) starts
 * only AFTER the request body is fully buffered
 * (`preview.ts` does `await c.req.raw.clone().arrayBuffer()` before
 * `proxyStartedAt`), so the client-visible duration is
 * `body upload time + ≤50s upstream`, not 50s total. Clamping this ceiling to
 * ~60s would abort every upload whose body alone takes longer than that on a
 * slow uplink — the exact failure `uploadTimeoutMsForBytes` exists to prevent.
 * At the assumed 256 KB/s floor this ceiling only binds above ~222 MB.
 */
const UPLOAD_TIMEOUT_CEILING_MS = 15 * 60_000;
/**
 * Assumed floor throughput. Deliberately pessimistic: the deadline exists to
 * catch a *stuck* upload, not to race a slow one, so erring long costs a late
 * error message while erring short costs a failed upload that would have
 * succeeded. ~256 KB/s ≈ a weak mobile uplink.
 */
const UPLOAD_ASSUMED_BYTES_PER_MS = 256;

/**
 * How long to give an upload of `bytes`.
 *
 * A flat 30s is the platform default for every request, which is right for a
 * JSON call and wrong for a body: a 200 KB screenshot and a 30 MB zip were
 * getting the same budget, and the zip lost. Scales with size, clamped at both
 * ends. Exported so callers (and tests) can reason about the deadline they are
 * about to be held to.
 */
export function uploadTimeoutMsForBytes(bytes?: number): number {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return UPLOAD_TIMEOUT_FLOOR_MS;
  }
  const scaled = UPLOAD_TIMEOUT_FLOOR_MS + bytes / UPLOAD_ASSUMED_BYTES_PER_MS;
  return Math.min(UPLOAD_TIMEOUT_CEILING_MS, Math.max(UPLOAD_TIMEOUT_FLOOR_MS, Math.round(scaled)));
}

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
      // A timeout or a deliberate abort is terminal — see `isUnretryableThrow`.
      if (isUnretryableThrow(err)) break;
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
export async function uploadFile(
  file: File | Blob,
  targetPath?: string,
  filename?: string,
  baseUrl?: string,
): Promise<UploadResult[]> {
  const base = requireBaseUrl(baseUrl);
  // The deadline follows the body. The platform-wide 30s is a hang detector
  // for a JSON call; against a 30 MB attachment it is a throughput limit, and
  // the attachment loses.
  const timeoutMs = uploadTimeoutMsForBytes(file.size);
  // The name the file must land under. `File.name` is the fallback for a host
  // that already named its blob; a bare `Blob` has none, and then the daemon
  // resolves the destination from the `path` field alone.
  const name = filename || (file instanceof File ? file.name : '') || '';
  return uploadWithRetry(
    () => {
      const form = new FormData();
      const rawPath = (targetPath ?? '').trim();
      if (rawPath) form.append('path', rawPath.startsWith('/') ? rawPath : `/${rawPath}`);
      // The name travels as its OWN field, not only as the multipart part's
      // `filename` parameter. Bun 1.3.14's multipart parser DROPS `filename`
      // on a ZERO-LENGTH part, so a genuinely empty upload reached the daemon
      // with `file.name === undefined` and landed as a file literally named
      // "undefined". The SDK used to dodge that by writing a single space into
      // every "new empty file" — which made every empty `.json` invalid and
      // every new file 1 byte of 0x20. This field survives an empty body; the
      // daemon reads it as the per-part fallback (`filenameHint` in
      // `apps/kortix-sandbox-agent-server/src/routes/files.ts`).
      if (name) form.append('filename', name);
      if (name) form.append('file', file, name);
      else form.append('file', file);
      return form;
    },
    (form) =>
      authenticatedFetch(`${base}/file/upload`, { method: 'POST', body: form }, { timeoutMs }),
  );
}

/**
 * Upload content to a specific path via the field-name-as-path convention.
 *
 * Goes through `authenticatedFetch` like every other write. It used to call a
 * bare `fetch()` with a hand-rolled `Authorization` header, which silently
 * skipped the size-scaled deadline, the 401 stale-token refresh-and-retry, the
 * `X-Kortix-Client` header, and `platformConfig().fetch` — so every host that
 * injects its own fetch (mobile, whitelabel) was bypassed on this one path.
 */
function uploadToPath(filePath: string, content: Blob, baseUrl?: string): Promise<UploadResult[]> {
  const base = requireBaseUrl(baseUrl);
  const timeoutMs = uploadTimeoutMsForBytes(content.size);
  return uploadWithRetry(
    () => {
      const form = new FormData();
      form.append(filePath, content, filePath.split('/').pop() || 'file');
      return form;
    },
    (form) =>
      authenticatedFetch(`${base}/file/upload`, { method: 'POST', body: form }, { timeoutMs }),
  );
}

/**
 * Create an EMPTY file at a path — 0 bytes, not one space.
 *
 * Implemented on `writeFile`, and that is a ROLLOUT requirement, not a style
 * choice. The `filename` form field `uploadFile` sends is read by the daemon,
 * and the daemon is **baked into the sandbox image**
 * (`/usr/local/bin/kortix-agent`, `apps/sandbox/Dockerfile`). `/v1/runtime-assets`
 * reconciles only the CLI binary and the managed skills (`cli_sha256`,
 * `managed_skills_hash`) — it does NOT ship the daemon. So this SDK reaches
 * production with the web app immediately while every sandbox provisioned
 * before the image rebuild keeps its OLD daemon for the life of the box.
 *
 * On an old daemon a genuinely 0-byte part loses its filename in Bun's
 * multipart parser and a direct upload lands as a file literally named
 * "undefined". `writeFile` renames the path the daemon REPORTED onto the
 * requested path, so both fleets converge on the right answer:
 *
 * - new daemon → temp name lands → renamed to the target;
 * - old daemon → "undefined" lands → renamed to the target.
 *
 * Concurrency holds on the old fleet too: two simultaneous creates both aim at
 * "undefined", the daemon's `O_EXCL` + suffix retry hands the second one
 * `undefined-<suffix>`, and each call renames only the path IT was told — so
 * they cannot cross.
 *
 * Returns `UploadResult[]` — the published shape, unchanged.
 */
export async function createFile(filePath: string, baseUrl?: string): Promise<UploadResult[]> {
  const base = requireBaseUrl(baseUrl);
  const rawPath = filePath.trim();
  const absolutePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const parts = absolutePath.split('/');
  // Keep the historical fallbacks exactly: a trailing slash yields 'untitled',
  // and a bare name anchors under /workspace.
  const fileName = parts.pop() || 'untitled';
  const dirPath = parts.join('/') || '/workspace';
  const written = await writeFile(
    `${dirPath}/${fileName}`,
    new Blob([], { type: 'application/octet-stream' }),
    base,
  );
  return [{ path: written.path, size: written.bytes }];
}

/** Copy a file (read source bytes → upload to dest). */
export async function copyFile(sourcePath: string, destPath: string, baseUrl?: string): Promise<UploadResult[]> {
  const base = requireBaseUrl(baseUrl);
  return uploadToPath(destPath, await readBlob(sourcePath, base), base);
}

// ── overwrite-in-place ───────────────────────────────────────────────────────

/** Parent directory of an absolute sandbox path ('/workspace/a/b.md' → '/workspace/a'). */
/**
 * Strip trailing `/` without a regex.
 *
 * The obvious `replace(/\/+$/, '')` is POLYNOMIAL (CodeQL js/polynomial-redos):
 * `\/+$` is unanchored, so on `"a" + "/".repeat(n) + "b"` the engine retries the
 * whole run from every position — O(n²). `filePath` arrives from host UI input,
 * so it is uncontrolled. An index walk is O(n) and needs no backtracking.
 *
 * `toSandboxAbsolutePath`'s `/^\/+/` is fine by contrast: anchored at the start,
 * so it is only ever attempted at position 0.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return value.slice(0, end);
}

function sandboxDirname(absPath: string): string {
  const index = absPath.lastIndexOf('/');
  return index <= 0 ? '/' : absPath.slice(0, index);
}

/** Final segment of an absolute sandbox path ('/workspace/a/b.md' → 'b.md'). */
function sandboxBasename(absPath: string): string {
  return absPath.slice(absPath.lastIndexOf('/') + 1);
}

/**
 * Short high-entropy token for the temp + backup names below.
 *
 * `crypto.randomUUID` exists only in a secure context (https or localhost), so
 * a self-hosted white-label served over plain http would throw — the same trap
 * `platform/session-id.ts` documents. Guarded, never bare.
 */
function writeToken(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(8);
    c.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Write `content` to the EXACT `filePath`, overwriting whatever is there.
 *
 * The daemon's upload endpoint never overwrites: it writes with `flag: 'wx'`
 * (`O_CREAT | O_EXCL`) and, on `EEXIST`, retries under a suffixed name,
 * returning the path the bytes actually landed at. So "save this edited file"
 * used to write a DIFFERENT file (`notes-mdx8k2-3f9a1c04.md`) while the viewer
 * re-read the original path and showed pre-edit bytes under a "File saved"
 * toast — silent data loss.
 *
 * This is the missing primitive: upload to a temp name, then `POST /file/rename`
 * over the target (`fs.rename` overwrites atomically). The existing file is
 * moved aside first and restored if the swap fails, so a failed write can never
 * destroy the original. Reported as `{ path, bytes }` for the path the bytes
 * ended up at — which is always the path you asked for, or a throw.
 *
 * `apps/cli` (`writeSessionFile`) and `apps/mobile` each hand-rolled this; they
 * are the reason it belongs here.
 */
export async function writeFile(
  filePath: string,
  content: Blob | File,
  baseUrl?: string,
): Promise<WriteFileResult> {
  const base = requireBaseUrl(baseUrl);
  const absPath = toSandboxAbsolutePath(stripTrailingSlashes(filePath.trim()));
  const name = sandboxBasename(absPath);
  if (!name) {
    throw new ApiError(`writeFile needs a file path, got "${filePath}"`, { code: 'INVALID_PATH' });
  }
  const parent = sandboxDirname(absPath);
  // A missing parent is the common case for a brand-new file; an existing one
  // makes this a no-op (mkdir is recursive + idempotent server-side).
  await mkdir(parent, base).catch(() => undefined);

  const token = writeToken();
  const results = await uploadFile(content, parent, `.${name}.kortix-write-${token}`, base);
  const uploaded = results[0]?.path;
  if (!uploaded) {
    throw new ApiError(`Upload returned no file for ${absPath}`, { code: 'UPLOAD_NO_RESULT' });
  }
  // The daemon's returned path is authoritative — it may have uniquified even
  // the temp name (a concurrent writer), and renaming the name we ASKED for
  // would then move the wrong file.
  const actual = toSandboxAbsolutePath(uploaded);

  const backupPath = `${absPath}.kortix-write-backup-${token}`;
  let backedUp = false;
  try {
    await renameFile(absPath, backupPath, base);
    backedUp = true;
  } catch {
    // Nothing at the target yet — no backup needed, and no failure either.
  }
  try {
    await renameFile(actual, absPath, base);
  } catch (error) {
    // Put the original back exactly where it was, then drop the orphaned temp.
    if (backedUp) await renameFile(backupPath, absPath, base).catch(() => undefined);
    await deleteFile(actual, base).catch(() => undefined);
    throw error;
  }
  if (backedUp) await deleteFile(backupPath, base).catch(() => undefined);

  const written = results[0]?.size;
  return { path: absPath, bytes: typeof written === 'number' ? written : content.size };
}

/** Delete a file/dir (recursive). Daemon `DELETE /file`. */
export async function deleteFile(filePath: string, baseUrl?: string): Promise<boolean> {
  const res = await authenticatedFetch(`${requireBaseUrl(baseUrl)}/file`, {
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
export async function mkdir(dirPath: string, baseUrl?: string): Promise<boolean> {
  const res = await authenticatedFetch(`${requireBaseUrl(baseUrl)}/file/mkdir`, {
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
export async function renameFile(from: string, to: string, baseUrl?: string): Promise<boolean> {
  const res = await authenticatedFetch(`${requireBaseUrl(baseUrl)}/file/rename`, {
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
export async function getCurrentProject(): Promise<OpenCodeProjectInfo> {
  // `/kortix/opencode/project-current` daemon passthrough, not raw `/project/current`.
  // Lazy import: this core module is in the rest layer's early init chain, and a
  // top-level import of daemon-read (-> current-runtime/auth) cycles backendApi.
  const { readDaemonOpencode } = await import('../runtime/daemon-read');
  return readDaemonOpencode<OpenCodeProjectInfo>('project-current');
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
  /** Overwrite-in-place. The daemon's upload NEVER overwrites — see `writeFile`. */
  write: writeFile,
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
