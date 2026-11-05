import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolveSandboxProjectId } from '../shared/preview-ownership';
import { workspaceFenceVerdict } from './workspace-binding';

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
 * The credential fence for a workspace-bound PAT (a project PAT or the
 * in-sandbox session `KORTIX_TOKEN`): it reaches a route only when the route
 * binds to the token's own workspace. ONE rule over ONE table,
 * `middleware/workspace-binding.ts`; read that file to add a route.
 *
 * Throws HTTPException(403) so the calling middleware aborts the chain.
 */
export async function enforceTokenProjectScope(
  c: Context,
  tokenProjectId: string,
  opts: { sessionBound?: boolean } = {},
): Promise<void> {
  const path = c.req.path;
  const verdict = await workspaceFenceVerdict(
    c.req.method,
    path,
    { workspaceId: tokenProjectId, sessionBound: Boolean(opts.sessionBound) },
    { sandboxWorkspace: resolveSandboxProjectId },
  );
  if (verdict.allowed) return;
  // NAME the principal and the check in the message. The global `app.onError`
  // logs `${method} ${path} -> ${status} [HTTPException] ${message}`, so a bare
  // reason made every denial indistinguishable in Better Stack: 2,338 identical
  // `POST /v1/platform/boot-timeline -> 403` lines over 7 days (2026-09-09)
  // named neither the credential nor the branch that rejected it.
  throw new HTTPException(403, {
    message:
      `${verdict.reason} ` +
      `[check=token-project-scope:${verdict.check} ` +
      `principal=${opts.sessionBound ? 'session-scoped-pat' : 'project-scoped-pat'} ` +
      `project=${tokenProjectId} path=${path}]`,
  });
}
