/**
 * The workspace resolver for account-key routes.
 *
 * An account-key route (`/v1/workspaces/:workspaceId/iam/…`, its permanent
 * alias `/v1/accounts/:workspaceId/iam/…`, `/scim/v2/workspaces/:workspaceId/…`)
 * names the workspace by EITHER key: the public workspace id (`project_id`) or
 * the account key (`account_id`). The handlers behind these routes were written
 * for the account key. This middleware maps the path id to the account key and
 * stores it under `WORKSPACE_ACCOUNT_ID_VAR`, which `accountIdParam(c)` returns.
 *
 * Resolution (one query on `kortix.workspaces`, `resolveWorkspace`):
 *   - a workspace id → its account key;
 *   - an account key with one active project → itself;
 *   - an account key with 0 active projects (a dormant account) or with several
 *     (a `split_pending` legacy account, `workspace_ambiguous`) → itself, the
 *     behavior every `/v1/accounts/:accountId` route always had;
 *   - an unknown id → itself, so the handler answers its own 403/404.
 * A non-uuid segment (`/v1/accounts/me`, `/v1/accounts/tokens`) is skipped
 * without a query.
 *
 * When the path names a workspace id, `PATH_WORKSPACE_ID_VAR` holds it and
 * `PATH_WORKSPACE_SPLIT_PENDING_VAR` says whether its account still holds other
 * projects; the workspace audit log uses both to stay inside the workspace.
 */
import type { Context, MiddlewareHandler } from 'hono';

import { WORKSPACE_ACCOUNT_ID_VAR } from '../shared/route-params';
import { isUuid } from '../shared/validate';
import { resolveWorkspace, WorkspaceAmbiguousError } from '../workspaces/surface';

/** Set when the path id is a workspace id (`project_id`). */
export const PATH_WORKSPACE_ID_VAR = 'pathWorkspaceId';
/** True when that workspace's account still holds other active projects. */
export const PATH_WORKSPACE_SPLIT_PENDING_VAR = 'pathWorkspaceSplitPending';

export interface ResolvedPathAccount {
  accountId: string;
  /** The workspace id when the path named one, else null. */
  workspaceId: string | null;
  splitPending: boolean;
}

/** Map one path id to the account key. Exported for tests. */
export async function resolvePathAccount(id: string): Promise<ResolvedPathAccount> {
  try {
    const ws = await resolveWorkspace(id);
    if (!ws) return { accountId: id, workspaceId: null, splitPending: false };
    const namedWorkspace = ws.workspaceId.toLowerCase() === id.toLowerCase();
    return {
      accountId: ws.accountId,
      workspaceId: namedWorkspace ? ws.workspaceId : null,
      splitPending: ws.splitPending,
    };
  } catch (err) {
    if (err instanceof WorkspaceAmbiguousError) return { accountId: id, workspaceId: null, splitPending: true };
    throw err;
  }
}

function setVar(c: Context, key: string, value: unknown): void {
  (c as unknown as { set(k: string, v: unknown): void }).set(key, value);
}

/**
 * `id` reads the path id; the default reads `:workspaceId`. Runs once per
 * request: a second mount of the same chain finds the var already set.
 */
export function resolveWorkspaceAccount(
  id: (c: Context) => string | undefined = (c) => c.req.param('workspaceId'),
): MiddlewareHandler {
  return async (c, next) => {
    const raw = id(c);
    const known = (c as unknown as { get(k: string): unknown }).get(WORKSPACE_ACCOUNT_ID_VAR);
    if (raw && !known && isUuid(raw)) {
      const resolved = await resolvePathAccount(raw);
      setVar(c, WORKSPACE_ACCOUNT_ID_VAR, resolved.accountId);
      if (resolved.workspaceId) {
        setVar(c, PATH_WORKSPACE_ID_VAR, resolved.workspaceId);
        setVar(c, PATH_WORKSPACE_SPLIT_PENDING_VAR, resolved.splitPending);
      }
    }
    await next();
  };
}

/** The path id of a request under `/v1/accounts/<id>` or `/v1/workspaces/<id>`, for a `/*` middleware. */
export function workspacePathSegment(c: Context): string | undefined {
  const parts = c.req.path.split('/');
  return parts[1] === 'v1' && (parts[2] === 'accounts' || parts[2] === 'workspaces') ? parts[3] : undefined;
}
