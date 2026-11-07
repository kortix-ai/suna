/**
 * Workspace routes: the canonical `/v1/workspaces` names and the legacy names
 * every client keeps using.
 *
 * A Kortix workspace is one entity with two physical keys (design:
 * `.agents/skills/learnings/work/workspaces/design.md` §0): the public
 * workspace id (`project_id`) and the internal account key (`account_id`).
 * The API serves every workspace route under `/v1/workspaces` and keeps the
 * old names mounted permanently:
 *
 * | Canonical                                   | Legacy (permanent alias)                 |
 * |---------------------------------------------|------------------------------------------|
 * | `/v1/workspaces[/…]`                        | `/v1/projects[/…]`                       |
 * | `/v1/workspaces/:workspaceId/<family>[/…]`  | `/v1/accounts/:workspaceId/<family>[/…]` |
 * | `/v1/me[/…]`                                | `/v1/accounts/me[/…]`                    |
 * | `/v1/invites[/…]`                           | `/v1/account-invites[/…]`                |
 * | `/v1/connectors/workspaces/:workspaceId/…`  | `/v1/connectors/projects/:workspaceId/…` |
 * | `/scim/v2/workspaces/:workspaceId/…`        | `/scim/v2/accounts/:workspaceId/…`       |
 * | `/v1/workspaces/:workspaceId/audit/events`  | `/v1/projects/:workspaceId/audit`        |
 * | `/v1/webhooks/workspaces/:workspaceId/…`    | `/v1/webhooks/projects/:workspaceId/…`   |
 *
 * The project audit slice is renamed, not prefix-swapped:
 * `/v1/workspaces/:workspaceId/audit` is the workspace audit log (the account
 * family), so the slice is `/audit/events`, beside the session's
 * `/sessions/:sessionId/audit/events`.
 *
 * `<family>` is one of {@link WORKSPACE_ACCOUNT_FAMILIES}: the settings the
 * account key holds (IAM, members, audit, billing requests, Capture, …).
 *
 * Ids: a canonical path takes the workspace id ONLY. An account id, an unknown
 * id or a workspace the caller cannot read answers
 * `404 { code: 'workspace_not_found' }` on every sub-path. A legacy path keeps
 * accepting either id. Uuids are case-insensitive.
 *
 * Not every legacy route is an alias. {@link WORKSPACE_MERGED_LEGACY_ROUTES}
 * names the legacy routes whose canonical name is a DIFFERENT route (the
 * workspace resource: list, create, record, update; the workspace audit log).
 * {@link WORKSPACE_LEGACY_ONLY_ROUTES} names the legacy routes with no
 * canonical name at all (the account-scoped creates and the quota).
 * {@link WORKSPACE_LEGACY_REPLACEMENTS} names, for each of these and for the
 * other legacy-meaning routes (`/v1/accounts`, `/v1/accounts/:id`,
 * `/v1/accounts/tokens`), the canonical route a client uses instead; the
 * OpenAPI spec marks each one `deprecated` with that pointer.
 * {@link workspaceAliasOf} applies both: the route manifest and the OpenAPI
 * spec read the alias relation from it, so they cannot disagree.
 * `/v1/accounts`, `/v1/accounts/:accountId` and `/v1/accounts/tokens` keep
 * their own handlers (legacy meaning, deprecated, served permanently).
 *
 * Route templates written before 2026-11-05 name the id `:projectId` or
 * `:accountId` ({@link renameWorkspaceRouteParams}).
 *
 * Every function here is pure and works on a route template
 * (`/v1/projects/:workspaceId/sessions`) and on a concrete path
 * (`/v1/projects/0b6…/sessions`) alike.
 */

/** Account-key route families served under `/v1/workspaces/:workspaceId/<family>`. */
export const WORKSPACE_ACCOUNT_FAMILIES = [
  'audit',
  'automations',
  'branding',
  'capture',
  'iam',
  'invites',
  'leave',
  'members',
  'secret-resources',
  'subscription-connections',
  'keys',
  'tokens',
  'top-up-requests',
] as const;

export type WorkspaceAccountFamily = (typeof WORKSPACE_ACCOUNT_FAMILIES)[number];

const FAMILY_SET: ReadonlySet<string> = new Set(WORKSPACE_ACCOUNT_FAMILIES);

/** True when `segment` (the path segment after the workspace id) is an account family. */
export function isWorkspaceAccountFamily(segment: string | undefined): segment is WorkspaceAccountFamily {
  return segment !== undefined && FAMILY_SET.has(segment);
}

/** `:projectId` / `:accountId` in a route template → `:workspaceId`. Other params stay. */
export function renameWorkspaceRouteParams(template: string): string {
  return template.replace(/:(projectId|accountId)(?![A-Za-z0-9_])/g, ':workspaceId');
}

/** `prefix` equal to `path` or followed by `/`. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function swapPrefix(path: string, from: string, to: string): string {
  return `${to}${path.slice(from.length)}`;
}

/** `/v1/accounts/<id>/<rest>` split; `null` when `path` is not an account-scoped path. */
/** The project audit slice, `/v1/projects/<id>/audit` ↔ `/v1/workspaces/<id>/audit/events`. */
const PROJECT_AUDIT = /^\/v1\/projects\/([^/]+)\/audit$/;
const WORKSPACE_AUDIT_EVENTS = /^\/v1\/workspaces\/([^/]+)\/audit\/events$/;

function accountScoped(path: string): { id: string; family: string } | null {
  const m = /^\/v1\/accounts\/([^/]+)\/([^/]+)/.exec(path);
  return m ? { id: m[1]!, family: m[2]! } : null;
}

/**
 * The canonical name of a legacy workspace route, or `null` when `path` has
 * no canonical alias. `/v1/projects/:workspaceId/sessions` →
 * `/v1/workspaces/:workspaceId/sessions`.
 */
export function canonicalWorkspaceRoute(path: string): string | null {
  const audit = PROJECT_AUDIT.exec(path);
  if (audit) return `/v1/workspaces/${audit[1]}/audit/events`;
  if (path.startsWith('/v1/webhooks/projects/')) {
    return swapPrefix(path, '/v1/webhooks/projects/', '/v1/webhooks/workspaces/');
  }
  if (under(path, '/v1/projects')) return swapPrefix(path, '/v1/projects', '/v1/workspaces');
  if (under(path, '/v1/accounts/me')) return swapPrefix(path, '/v1/accounts/me', '/v1/me');
  if (under(path, '/v1/account-invites')) return swapPrefix(path, '/v1/account-invites', '/v1/invites');
  if (path.startsWith('/v1/connectors/projects/')) {
    return swapPrefix(path, '/v1/connectors/projects/', '/v1/connectors/workspaces/');
  }
  if (path.startsWith('/scim/v2/accounts/')) return swapPrefix(path, '/scim/v2/accounts/', '/scim/v2/workspaces/');
  const scoped = accountScoped(path);
  if (scoped && isWorkspaceAccountFamily(scoped.family)) {
    return swapPrefix(path, '/v1/accounts/', '/v1/workspaces/');
  }
  return null;
}

/**
 * The legacy name of a canonical workspace route, or `null` when `path` is not
 * under a canonical prefix. `/v1/workspaces/:workspaceId/iam/groups` →
 * `/v1/accounts/:workspaceId/iam/groups`; `/v1/workspaces/:workspaceId/sessions`
 * → `/v1/projects/:workspaceId/sessions`.
 *
 * Path-based checks that predate the workspace mount (the project-token fence,
 * request deadlines, error mapping, audit labels) run on this name, so a
 * canonical request is judged exactly like its legacy twin.
 */
export function legacyWorkspaceRoute(path: string): string | null {
  const audit = WORKSPACE_AUDIT_EVENTS.exec(path);
  if (audit) return `/v1/projects/${audit[1]}/audit`;
  if (path.startsWith('/v1/webhooks/workspaces/')) {
    return swapPrefix(path, '/v1/webhooks/workspaces/', '/v1/webhooks/projects/');
  }
  if (under(path, '/v1/workspaces')) {
    const family = /^\/v1\/workspaces\/[^/]+\/([^/]+)/.exec(path)?.[1];
    return isWorkspaceAccountFamily(family)
      ? swapPrefix(path, '/v1/workspaces/', '/v1/accounts/')
      : swapPrefix(path, '/v1/workspaces', '/v1/projects');
  }
  if (under(path, '/v1/me')) return swapPrefix(path, '/v1/me', '/v1/accounts/me');
  if (under(path, '/v1/invites')) return swapPrefix(path, '/v1/invites', '/v1/account-invites');
  if (path.startsWith('/v1/connectors/workspaces/')) {
    return swapPrefix(path, '/v1/connectors/workspaces/', '/v1/connectors/projects/');
  }
  if (path.startsWith('/scim/v2/workspaces/')) return swapPrefix(path, '/scim/v2/workspaces/', '/scim/v2/accounts/');
  return null;
}

/**
 * Legacy routes whose canonical name is a different route, so they are not an
 * alias of it. Each `METHOD /path` names the legacy route:
 *
 * - `GET /v1/projects` lists ONE account's projects; `GET /v1/workspaces` lists
 *   every workspace of the caller, across accounts.
 * - `POST /v1/projects` imports a GitHub repository into an account;
 *   `POST /v1/workspaces` creates a new workspace.
 * - `GET /v1/projects/:workspaceId` is the project record;
 *   `GET /v1/workspaces/:workspaceId` adds the role, the state and the
 *   workspace settings block.
 * - `PATCH /v1/projects/:workspaceId` ignores unknown keys;
 *   `PATCH /v1/workspaces/:workspaceId` refuses a settings key with 400
 *   `workspace_setting_read_only` and answers the Workspace.
 *
 * The project audit slice (`GET /v1/projects/:workspaceId/audit`) is an alias
 * of `GET /v1/workspaces/:workspaceId/audit/events`, not of the workspace
 * audit log.
 */
export const WORKSPACE_MERGED_LEGACY_ROUTES: readonly string[] = [
  'GET /v1/projects',
  'POST /v1/projects',
  'GET /v1/projects/:workspaceId',
  'PATCH /v1/projects/:workspaceId',
];

/**
 * Legacy routes with no canonical name (K3): they act on an account, not on a
 * workspace. `POST /v1/workspaces` creates a workspace with a managed
 * repository (JSON, or the phases with `Accept: text/event-stream`) and has
 * no quota, so the account-scoped managed creates and the quota pre-check
 * stay on `/v1/projects` only.
 *
 * The repository creates (`/link-repository`, `/create-repo`) and the
 * transfer are aliases (2026-11-06): `POST /v1/workspaces/link-repository`,
 * `POST /v1/workspaces/create-repo`, `POST /v1/workspaces/:workspaceId/transfer`.
 */
export const WORKSPACE_LEGACY_ONLY_ROUTES: readonly string[] = [
  'POST /v1/projects/provision',
  'POST /v1/projects/provision-stream',
  'GET /v1/projects/quota',
];

/**
 * Every legacy route that keeps its own meaning (not an alias), with the
 * canonical route a client calls instead. The API serves each one
 * permanently; the OpenAPI spec marks it `deprecated` and names the
 * replacement (`x-kortix-replaced-by`). Keys and values are `METHOD template`.
 */
export const WORKSPACE_LEGACY_REPLACEMENTS: Readonly<Record<string, string>> = {
  // One account's projects → every workspace; a repository import into an account → the workspace import.
  'GET /v1/projects': 'GET /v1/workspaces',
  'POST /v1/projects': 'POST /v1/workspaces/link-repository',
  'GET /v1/projects/:workspaceId': 'GET /v1/workspaces/:workspaceId',
  'PATCH /v1/projects/:workspaceId': 'PATCH /v1/workspaces/:workspaceId',
  'POST /v1/projects/provision': 'POST /v1/workspaces',
  'POST /v1/projects/provision-stream': 'POST /v1/workspaces',
  'GET /v1/projects/quota': 'POST /v1/workspaces',
  // The account record and list: the workspace is the tenant.
  'GET /v1/accounts': 'GET /v1/workspaces',
  'POST /v1/accounts': 'POST /v1/workspaces',
  'GET /v1/accounts/:workspaceId': 'GET /v1/workspaces/:workspaceId',
  'PATCH /v1/accounts/:workspaceId': 'PATCH /v1/workspaces/:workspaceId',
  // The account picked by `?account_id=` (or the default account): the path names the workspace.
  'GET /v1/accounts/tokens': 'GET /v1/workspaces/:workspaceId/tokens',
  'POST /v1/accounts/tokens': 'POST /v1/workspaces/:workspaceId/tokens',
  'DELETE /v1/accounts/tokens/:tokenId': 'DELETE /v1/workspaces/:workspaceId/tokens/:tokenId',
};

const NOT_ALIASES: ReadonlySet<string> = new Set([...WORKSPACE_MERGED_LEGACY_ROUTES, ...WORKSPACE_LEGACY_ONLY_ROUTES]);

/**
 * The canonical route a legacy route is a permanent alias of, or `null`.
 * `path` is a route template (`/v1/projects/:workspaceId/sessions`); `has`
 * says whether a `METHOD path` route exists. A legacy route is an alias when
 * its canonical name exists and it is not in {@link WORKSPACE_MERGED_LEGACY_ROUTES}
 * or {@link WORKSPACE_LEGACY_ONLY_ROUTES}. The one alias rule of the route
 * manifest (`apps/api/scripts/dump-routes.ts`) and the OpenAPI spec.
 */
export function workspaceAliasOf(
  method: string,
  path: string,
  has: (method: string, path: string) => boolean,
): string | null {
  const m = method.toUpperCase();
  if (NOT_ALIASES.has(`${m} ${path}`)) return null;
  const canonical = canonicalWorkspaceRoute(path);
  return canonical && has(m, canonical) ? canonical : null;
}

/** `legacyWorkspaceRoute(path) ?? path`: the name pre-workspace path checks understand. */
export function asLegacyWorkspaceRoute(path: string): string {
  return legacyWorkspaceRoute(path) ?? path;
}
