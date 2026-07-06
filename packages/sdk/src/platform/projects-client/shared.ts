// Shared helpers + cross-cutting types used by multiple projects-client modules.

export type AccountRole = 'owner' | 'admin' | 'member';
/** `manager` (the former top project role) was retired by the project-role
 *  collapse — `editor` is now the top project role. */
export type ProjectRole = 'editor' | 'member';

export type ConnectorSharing =
  | { mode: 'project' }
  | { mode: 'private'; ownerId: string }
  | { mode: 'members'; memberIds?: string[]; groupIds?: string[] };

export interface ProjectGitConnection {
  connection_id: string;
  account_id: string;
  project_id: string;
  provider: string;
  repo_url: string;
  repo_owner: string | null;
  repo_name: string | null;
  external_repo_id: string | null;
  default_branch: string;
  auth_method: string;
  installation_id: string | null;
  visibility: string | null;
  status: string;
  last_validated_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProjectFileEntry {
  path: string;
  type: 'file';
  size: number | null;
}

/**
 * Unwrap a `backendApi` response, throwing on failure. `fallbackMessage` is
 * used only when the response carries no `error` of its own (e.g. a 200 whose
 * body is missing/empty) — pass the old per-endpoint string a call site had
 * before it was consolidated onto this shared helper, so failures still read
 * like "Failed to connect" instead of a generic "Project request failed".
 */
export function unwrap<T>(
  response: { data?: T; success: boolean; error?: Error },
  fallbackMessage = 'Project request failed',
) {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error(fallbackMessage);
  }
  return response.data;
}

// ── Explicit-token server fetch ─────────────────────────────────────────────
//
// Next.js server actions and route handlers run per-request, before (or
// without ever wiring) the SDK's process-wide `configureKortix()` seam — and
// even where the host app has called `configureKortix()`, that singleton
// must not be trusted to carry one request's bearer token across concurrent
// requests on the same server process (the last `configureKortix()` call
// wins for every other in-flight request). These callers already resolved
// the caller's access token themselves (e.g. from a Supabase server
// session), so they fetch with it directly instead of going through
// `backendApi`.
//
// A general-purpose fix for this class of problem — any "Kortix as a
// Backend" server wrapping Kortix on behalf of multiple concurrent
// users/tenants, not just this one explicit-token pattern — lives at
// `@kortix/sdk/server`: `runWithKortix(config, fn)` / `createScopedKortix(config)`
// isolate each call's config in a Node `AsyncLocalStorage` context instead of
// the shared global, so concurrent requests with different tokens never
// clobber each other. Prefer that over hand-rolling more explicit-token
// helpers like the ones below for new server-side call sites.

export interface ServerTokenOptions {
  /** Absolute backend base URL, with or without a trailing `/v1`. */
  backendUrl: string;
  /** Caller's bearer token (Supabase JWT), already resolved server-side. */
  accessToken: string;
  timeoutMs?: number;
}

export function normalizeServerBackendBase(backendUrl: string): string {
  return backendUrl.replace(/\/v1\/?$/, '');
}

/**
 * Best-effort explicit-token GET. Returns `null` on any non-2xx status,
 * network error, or missing credentials — every current caller is a
 * best-effort server-side lookup that falls back to a default when the read
 * fails, never something that must throw.
 */
export async function serverTokenGet<T>(
  opts: ServerTokenOptions,
  path: string,
): Promise<T | null> {
  if (!opts.backendUrl || !opts.accessToken) return null;
  const base = normalizeServerBackendBase(opts.backendUrl);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
