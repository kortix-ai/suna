import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolveSandboxProjectId } from '../shared/preview-ownership';

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
 * Write-only platform sinks whose ONLY caller is the in-guest sandbox daemon
 * reporting on its OWN session. Every one of them is reached with the
 * session-scoped `KORTIX_TOKEN`, which is an `isAccountToken` PAT — so it lands
 * in the PAT branch of `resolveSupabaseAuth` and is judged by
 * `enforceTokenProjectScope`, NOT by the legacy `sandboxTokenPathAllowed`
 * allowlist above (that one only covers `kortix_`/`kortix_sb_` API keys, which
 * nothing has minted for a sandbox since the unified-credential cutover).
 *
 * A sink that is missing here is not "secure" — it is UNREACHABLE, answering
 * 403 to a fire-and-forget push that nobody sees fail. That is exactly what
 * happened twice:
 *   - `/v1/platform/runtime-projection`, observed live 2026-08-27.
 *   - `/v1/platform/boot-timeline`, observed live in prod for the 7 days to
 *     2026-09-09: 2,338 x `POST /v1/platform/boot-timeline -> 403
 *     [HTTPException]`, 1,414 of them in the last two days against just 47
 *     successes (97% denied). Prod minted 583 session-scoped PATs and ZERO
 *     sandbox API keys in that window, so effectively every boot was denied and
 *     no in-guest boot timeline was recorded.
 *
 * ADD A SINK HERE when you add a route whose caller is the daemon holding
 * `KORTIX_TOKEN`. `__tests__/unit-boot-timeline-auth-mount.test.ts` pins the
 * membership of this set for the same reason it pins the middleware mount.
 */
const SESSION_BOUND_PLATFORM_SINKS = new Set([
  '/v1/platform/runtime-projection',
  '/v1/platform/boot-timeline',
]);

/**
 * A project-scoped CLI PAT can only act on its bound project. Reject
 * the request if:
 *   - the URL targets a `:projectId` parameter that doesn't match, OR
 *   - the URL is an account-level route (`/v1/accounts/*` other than
 *     `/v1/accounts/me`, which we allow as a self-identity probe), OR
 *   - the URL is a webhook / preview / system route the token has no
 *     business hitting — UNLESS it is the sandbox-proxy path
 *     (`/v1/p/{sandboxId}/{port}/...`) AND the sandbox belongs to the
 *     token's own project (see below).
 *
 * Throws HTTPException(403) so the calling middleware aborts the chain.
 */
export async function enforceTokenProjectScope(
  c: Context,
  tokenProjectId: string,
  opts: { sessionBound?: boolean } = {},
): Promise<void> {
  const path = c.req.path;

  // Daemon-only platform sinks (SESSION_BOUND_PLATFORM_SINKS). A session
  // sandbox holds exactly ONE credential — a project+SESSION-scoped PAT ("One
  // sandbox, one session-scoped Kortix credential",
  // platform/services/session-sandbox.ts) — so without this branch the daemon's
  // push can never reach the sink on any environment. Allowed ONLY for a
  // session-BOUND token; an ordinary project PAT stays denied. Each handler
  // re-verifies the binding against `session_sandboxes` (sandbox id ∧ session ∧
  // account ∧ live) via isSessionSandboxCredential, so this gate is
  // authentication, not the authorization boundary.
  if (opts.sessionBound && SESSION_BOUND_PLATFORM_SINKS.has(path)) return;

  // Whitelist a couple of self-identity probes the CLI hits even for
  // project/session-scoped tokens. `/v1/accounts/me` lets the agent confirm
  // "what project/session/agent am I bound to?".
  if (path === '/v1/accounts/me') return;

  // Cost routes enforce the project binding and usage leaf in their handlers.
  if (
    c.req.method === 'GET' &&
    (path === '/v1/usage/cost-summary' || path === '/v1/usage/cost-by-project')
  ) return;

  // `/v1/skills` — the kortix-managed system skills (how Kortix itself works).
  // This function is default-deny, and the in-sandbox `KORTIX_TOKEN` is
  // exactly a project+session-scoped PAT, so without this branch the ONE caller
  // these routes exist for gets a 403: every baked sandbox seeds a kortix-system
  // skill telling the agent to run `kortix skills get <name>`.
  // Safe to allow — the content is static template text that is byte-identical
  // for every caller, carries no account or project data, and is served from the
  // shipped @kortix/starter package rather than any per-tenant store. There is
  // no scope to enforce here; the token gate is authentication, not
  // authorization.
  if (path === '/v1/skills' || path.startsWith('/v1/skills/')) return;

  // `/v1/runtime-assets` — the `kortix-agent` daemon binary, the CLI binary, and
  // the managed-skill overlay this deploy bakes into sandboxes. The prefix test
  // covers every payload route including `/agent`, which is deliberate: the
  // daemon converging ITSELF is the same caller with the same token as the
  // daemon converging its CLI. Same reasoning as `/v1/skills`
  // above, and for the same single caller: the in-sandbox daemon reconciles
  // against these on every session start/restart/resume holding exactly a
  // project+session-scoped `KORTIX_TOKEN`. A 403 here means a sandbox can
  // never repair a stale CLI, which is the whole bug these routes exist to fix.
  // Safe to allow — the payloads are the deploy's own build artifacts, identical
  // for every caller, with no account or project data in them. Authentication,
  // not authorization.
  if (path.startsWith('/v1/runtime-assets/')) return;

  const deny = (check: string, reason: string): never => {
    // NAME the principal and the check in the message. The global `app.onError`
    // logs `${method} ${path} -> ${status} [HTTPException] ${message}`, so a
    // bare reason string made every one of these denials indistinguishable in
    // Better Stack — 2,338 identical `POST /v1/platform/boot-timeline -> 403
    // [HTTPException]` lines over 7 days named neither the credential that was
    // rejected nor the branch that rejected it, which is why the boot-timeline
    // gate defect above went unnoticed for weeks.
    throw new HTTPException(403, {
      message:
        `${reason} ` +
        `[check=token-project-scope:${check} ` +
        `principal=${opts.sessionBound ? 'session-scoped-pat' : 'project-scoped-pat'} ` +
        `project=${tokenProjectId} path=${path}]`,
    });
  };

  // Reject other account-level routes outright.
  if (path.startsWith('/v1/accounts/') || path === '/v1/accounts') {
    deny('account-level-route', 'Project-scoped token cannot call account-level routes');
  }

  // `/v1/projects/:projectId/...` AND `/v1/connectors/projects/:projectId/...` —
  // both are project-scoped surfaces. Require the URL id to match the token's
  // project. The connector branch intentionally includes both gateway and
  // connector-management routes: the unified Connector MCP exposes add/remove
  // connector tools from inside the sandbox, while individual routes still gate
  // mutations via project.write in resolveAdmin.
  const m =
    path.match(/^\/v1\/projects\/([^/]+)/) ?? path.match(/^\/v1\/connectors\/projects\/([^/]+)/);
  if (m) {
    const urlProjectId = m[1];
    if (urlProjectId !== tokenProjectId) {
      deny('cross-project', 'Project-scoped token cannot access a different project');
    }
    return;
  }

  // Bare `/v1/projects` (list) is also account-scoped: a project-bound
  // token shouldn't enumerate other projects.
  if (path === '/v1/projects') {
    deny('project-list', 'Project-scoped token cannot list projects');
  }

  // Sandbox-proxy path — this is what session.send()/stream() and other
  // runtime.* SDK calls actually hit (NOT /v1/projects/:id/*). Without this
  // branch a project PAT could authenticate REST calls but never drive an
  // agent turn. Allow it through ONLY for a sandbox that resolves back to
  // THIS token's own project — resolved via `session_sandboxes` (one indexed
  // lookup, sandbox_id is the PK). A lookup miss or a mismatched project both
  // deny, same as every other surface a project PAT has no business on; this
  // never widens access to another project's or another account's sandbox.
  const previewSandboxId = extractPreviewSandboxId(path);
  if (previewSandboxId) {
    const sandboxProjectId = await resolveSandboxProjectId(previewSandboxId);
    if (sandboxProjectId && sandboxProjectId === tokenProjectId) {
      return;
    }
    deny(
      'foreign-sandbox',
      'Project-scoped token cannot access a sandbox outside its project',
    );
  }

  // All other surfaces (router, billing, channels, etc.) are
  // account-level — refuse.
  deny('default-deny', 'Project-scoped token cannot call this surface');
}
