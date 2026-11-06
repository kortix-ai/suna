import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolveSandboxProjectId } from '../shared/preview-ownership';
import { WorkspaceAmbiguousError, resolveWorkspace } from '../workspaces/surface';
import {
  CREDENTIAL_FENCE_REFUSED_CODE,
  WORKSPACE_PARAM_NAMES,
  canonicalIdParam,
  readsWorkspaceParams,
  workspaceFenceVerdict,
  type AccountWorkspace,
} from './workspace-binding';

const PREVIEW_SESSION_COOKIE = '__preview_session';
// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Set (or refresh) the preview session cookie.
 * Scoped to /v1/p/ so it only applies to preview proxy routes.
 * SameSite=Lax allows the cookie on same-site navigations and sub-resource loads.
 * Max-Age=3600 (1 hour) — the frontend refreshes the token periodically.
 */
export function setPreviewSessionCookie(c: Context, token: string) {
  const encoded = encodeURIComponent(token);
  c.header(
    'Set-Cookie',
    `${PREVIEW_SESSION_COOKIE}=${encoded}; Path=/v1/p/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
    { append: true },
  );
}

export function extractPreviewSandboxId(path: string): string | null {
  const match = path.match(/^\/v1\/p\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  const segment = match[1];
  return segment === 'auth' || segment === 'share' ? null : segment;
}

/**
 * The credential fence for a workspace-bound key (a workspace key, a project
 * CLI token or the in-sandbox session `KORTIX_TOKEN`): it reaches a request
 * only when the request's workspace is its own. ONE rule over ONE table,
 * `middleware/workspace-binding.ts`; read that file to add a route.
 *
 * Throws HTTPException(403) `credential_fence_refused` so the calling
 * middleware aborts the chain.
 */
export async function enforceTokenProjectScope(
  c: Context,
  tokenProjectId: string,
  opts: { sessionBound?: boolean; principal?: string } = {},
): Promise<void> {
  const path = c.req.path;
  const method = c.req.method;
  const workspaceId = canonicalIdParam(tokenProjectId);
  const verdict = await workspaceFenceVerdict(
    method,
    path,
    { workspaceId, sessionBound: Boolean(opts.sessionBound) },
    { sandboxWorkspace: resolveSandboxProjectId, accountWorkspace, workspaceSplitPending },
    readsWorkspaceParams(method, path) ? { ids: await requestWorkspaceParams(c) } : undefined,
  );
  if (verdict.allowed) return;
  // NAME the principal and the check in the message. The global `app.onError`
  // logs `${method} ${path} -> ${status} [HTTPException] ${message}`, so a bare
  // reason made every denial indistinguishable in Better Stack: 2,338 identical
  // `POST /v1/platform/boot-timeline -> 403` lines over 7 days (2026-09-09)
  // named neither the credential nor the branch that rejected it.
  const message =
    `${verdict.reason} ` +
    `[check=token-project-scope:${verdict.check} ` +
    `principal=${opts.principal ?? (opts.sessionBound ? 'session-scoped-pat' : 'project-scoped-pat')} ` +
    `project=${workspaceId} path=${path}]`;
  // A typed body: the CLI picks its remedy from `code`, and no kortix.yaml
  // grant can lift a fence refusal, so it must never read as a grant miss.
  throw new HTTPException(403, {
    message,
    res: new Response(
      JSON.stringify({ error: true, message, status: 403, code: CREDENTIAL_FENCE_REFUSED_CODE, check: verdict.check }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ),
  });
}

/** `account → workspace` for the fence: the one live workspace, `ambiguous`, or null. */
async function accountWorkspace(accountId: string): Promise<AccountWorkspace> {
  try {
    const resolved = await resolveWorkspace(accountId);
    return resolved ? resolved.workspaceId : null;
  } catch (err) {
    if (err instanceof WorkspaceAmbiguousError) return 'ambiguous';
    throw err;
  }
}

/** The key's own workspace belongs to a split_pending legacy account. */
async function workspaceSplitPending(workspaceId: string): Promise<boolean> {
  return (await resolveWorkspace(workspaceId))?.splitPending === true;
}

/**
 * The workspace ids a `reach: 'param'` request names: `account_id`,
 * `workspace_id` and `project_id` in the query string and in the body.
 *
 * The body is read whatever the Content-Type says. Handlers call
 * `c.req.json()`, and Hono parses that for `text/plain`, a form type or no
 * header at all; a fence that read only `application/json` let a bound
 * credential name another workspace by changing one header. The raw text is
 * cached by Hono, so the handler reads the same body again. A body that is
 * not JSON is read as form fields.
 */
export async function requestWorkspaceParams(c: Context): Promise<string[]> {
  const ids: string[] = [];
  for (const name of WORKSPACE_PARAM_NAMES) {
    for (const value of c.req.queries(name) ?? []) if (value) ids.push(value);
  }
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return ids;
  const text = await c.req.text().catch(() => '');
  if (!text) return ids;
  let fields: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
  } catch {
    const form = new URLSearchParams(text);
    fields = {};
    for (const name of WORKSPACE_PARAM_NAMES) {
      const values = form.getAll(name).filter(Boolean);
      for (const value of values) ids.push(value);
    }
  }
  if (fields) {
    for (const name of WORKSPACE_PARAM_NAMES) {
      const value = fields[name];
      if (typeof value === 'string' && value) ids.push(value);
    }
  }
  return ids;
}
