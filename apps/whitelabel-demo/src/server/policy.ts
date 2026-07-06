/**
 * Wrapper-mode route policy — the single explicit table of what an
 * authenticated wrapper end user is allowed to reach through
 * `app/api/kortix/[...path]/route.ts`.
 *
 * Deny-by-default. This is deliberately NARROWER than what a project-scoped
 * Kortix PAT can do (`apps/api/src/middleware/auth.ts`'s
 * `enforceTokenProjectScope`) — that gate protects ONE project's token from
 * reaching other projects; this one protects an entire Kortix ACCOUNT (the
 * operator's, behind `KORTIX_API_KEY`) from an unbounded number of wrapper end
 * users, so it also blocks account-admin surfaces (members, invites, billing,
 * GitHub App installs, platform/admin) outright — those are the operator's to
 * manage from their own Kortix dashboard, never delegated to end users.
 *
 * Every rule below is derived from which `@kortix/sdk` calls this app's own
 * UI actually makes (`grep -rn 'kortix\.' src` in `apps/whitelabel-demo`) —
 * see the per-rule comments for the reasoning, not just the shape.
 */

export interface PolicyResult {
  allow: boolean;
  /** Only meaningful when `allow` is false. */
  status: number;
  reason: string;
  /** `GET /projects` → the proxy should filter the response to owned projects. */
  filterProjectsList?: boolean;
  /** `POST /projects/provision` → the proxy should record the new project as owned. */
  recordProvisionOwner?: boolean;
}

function allow(extra: Partial<PolicyResult> = {}): PolicyResult {
  return { allow: true, status: 200, reason: '', ...extra };
}

function deny(status: number, reason: string): PolicyResult {
  return { allow: false, status, reason };
}

/**
 * @param method  HTTP method (any case).
 * @param path    Upstream path with the leading `/v1` and any leading/trailing
 *                slashes stripped, e.g. `projects/abc123/gateway/sessions`,
 *                `accounts`, `p/sb_123/3000/index.html`.
 * @param isOwner Predicate: does the caller own this project id?
 */
export function evaluatePolicy(
  method: string,
  path: string,
  isOwner: (projectId: string) => boolean,
): PolicyResult {
  const p = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const m = method.toUpperCase();

  // ── Preview proxy (`/v1/p/...`) ───────────────────────────────────────────
  // Covers the sandbox runtime proxy (`p/{sandboxId}/{port}/...` — every REST
  // call, SSE stream, and opencode runtime call the SDK makes for an active
  // session), the preview session-cookie mint (`p/auth`), and public-share
  // creation (`p/share`, used by the preview panel's "Create public share").
  //
  // The proxy has ALREADY required a valid app session before policy ever
  // runs (see route.ts) — that's the only check enforced here. We deliberately
  // do NOT cross-check sandbox → project ownership at this layer: there is no
  // cheap, already-cached sandboxId → projectId map available here (building
  // one would mean an extra upstream round-trip on every proxied byte of a
  // live dev-server response). The ownership-checked path is
  // `/api/preview-token` (mints a project-scoped token only for a project the
  // caller owns) — the preview panel uses that for the iframe itself in
  // wrapper mode. This rule is the documented, narrower fallback: "any valid
  // session can reach the proxy surface," not "any valid session can reach
  // any sandbox."
  if (/^p\//.test(p) || p === 'p') return allow();

  // ── Projects: bare collection ─────────────────────────────────────────────
  if (p === 'projects' && m === 'GET') return allow({ filterProjectsList: true });
  if (p === 'projects' && m === 'POST') {
    return deny(
      403,
      'Use /projects/provision — plain project creation bypasses per-user ownership tracking in wrapper mode.',
    );
  }
  if (p === 'projects/create-repo') {
    return deny(403, 'Not used by this app; blocked by default in wrapper mode.');
  }
  if (p === 'projects/provision' && m === 'POST') return allow({ recordProvisionOwner: true });

  // ── Projects: scoped to one id ────────────────────────────────────────────
  // Everything the app does once a project exists — detail, sessions,
  // gateway (cost/logs), secrets, sandbox, llm-catalog, settings — all live
  // under `projects/{id}/...`. Connector/policy management goes through
  // `executor/projects/{id}/...` instead. Both require ownership of `{id}`.
  const projMatch = p.match(/^projects\/([^/]+)(?:\/.*)?$/);
  if (projMatch) {
    return isOwner(projMatch[1]) ? allow() : deny(403, "You don't have access to this project.");
  }
  const execMatch = p.match(/^executor\/projects\/([^/]+)(?:\/.*)?$/);
  if (execMatch) {
    return isOwner(execMatch[1]) ? allow() : deny(403, "You don't have access to this project.");
  }

  // ── Accounts: self-identity probe only ────────────────────────────────────
  // Mirrors the upstream project-scoped-PAT allowlist in
  // `enforceTokenProjectScope` (`/v1/accounts/me` only). Every other
  // `/accounts*` route — list, create, members, invites, leave, billing — is
  // operator-only account administration and is NOT exposed to wrapper end
  // users. Lumen's own `/account` page is a direct-mode-only surface in
  // wrapper mode (see `src/app/account/page.tsx`).
  if (p === 'accounts/me' && m === 'GET') return allow();
  if (p === 'accounts' || p.startsWith('accounts/')) {
    return deny(403, 'Account administration is not exposed in wrapper mode.');
  }

  // ── Everything else ────────────────────────────────────────────────────────
  // billing/*, platform/* (operator sandbox-fleet admin), transcription,
  // github/* (App installs are account-level) — none of these are used by
  // this app's UI, and none belong to a single project a user owns. Deny by
  // default rather than silently widen the surface later.
  return deny(403, `Route not permitted in wrapper mode: ${m} /${p}`);
}
