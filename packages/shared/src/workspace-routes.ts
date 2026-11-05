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
 *
 * `<family>` is one of {@link WORKSPACE_ACCOUNT_FAMILIES}: the settings the
 * account key holds (IAM, members, audit, billing requests, Capture, …). A
 * family route resolves the path id to the account key, so it accepts either
 * id. Two names are NOT aliases, because the canonical route merges two old
 * ones: `GET /v1/workspaces/:workspaceId/audit` (the workspace audit log) and
 * `GET /v1/workspaces/:workspaceId` (the project record plus the workspace
 * settings), see {@link WORKSPACE_MERGED_LEGACY_ROUTES}. `/v1/accounts`,
 * `/v1/accounts/:accountId` and `/v1/accounts/tokens` keep their own handlers.
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
 * Legacy routes whose canonical name answers more than they do, so they are
 * not an alias of it: `GET /v1/workspaces/:workspaceId` adds the `workspace`
 * settings block to the project record, and `GET /v1/workspaces/:workspaceId/audit`
 * is the workspace audit log (the account log of the workspace), not the
 * project slice. Each `METHOD /path` names the legacy route.
 */
export const WORKSPACE_MERGED_LEGACY_ROUTES: readonly string[] = [
  'GET /v1/projects/:workspaceId',
  'GET /v1/projects/:workspaceId/audit',
];

/** `legacyWorkspaceRoute(path) ?? path`: the name pre-workspace path checks understand. */
export function asLegacyWorkspaceRoute(path: string): string {
  return legacyWorkspaceRoute(path) ?? path;
}
