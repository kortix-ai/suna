/**
 * Read the workspace path parameter of a request.
 *
 * Every workspace route names its id `:workspaceId` (`/v1/workspaces/:workspaceId/…`
 * and the permanent aliases `/v1/projects/:workspaceId/…` and
 * `/v1/accounts/:workspaceId/…`). The route-param codemod
 * (`scripts/codemods/workspace-route-params.ts`) rewrote every
 * `c.req.param('projectId')` to `workspaceIdParam(c)` and every
 * `c.req.param('accountId')` to `accountIdParam(c)`.
 *
 * Both helpers also read the pre-codemod names, so a router or a test app that
 * still declares `:projectId` / `:accountId` keeps working.
 */

/** The narrow slice of a Hono `Context` these helpers read. */
export interface RouteParamContext {
  req: { param(name: string): string | undefined };
  get?: (key: never) => unknown;
}

/**
 * Context key the workspace resolver middleware sets: the account key
 * (`account_id`) of the workspace the path names. See
 * `middleware/workspace-account.ts`.
 */
export const WORKSPACE_ACCOUNT_ID_VAR = 'workspaceAccountId';

function contextVar(c: RouteParamContext, key: string): string | undefined {
  if (typeof c.get !== 'function') return undefined;
  const value = (c.get as unknown as (k: string) => unknown)(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The workspace id (`project_id`) in the path. */
export function workspaceIdParam(c: RouteParamContext): string {
  return (c.req.param('workspaceId') ?? c.req.param('projectId')) as string;
}

/**
 * The account key (`account_id`) of the workspace in the path.
 *
 * On an account route the path id may be a workspace id (`/v1/workspaces/<id>/iam`)
 * or an account id (`/v1/accounts/<id>/iam`). The resolver middleware maps it to
 * the account key and stores it under `WORKSPACE_ACCOUNT_ID_VAR`. Without the
 * middleware (a unit test app) the raw path value is returned, which is the
 * behavior every account route had before the workspace mount.
 */
export function accountIdParam(c: RouteParamContext): string {
  return (contextVar(c, WORKSPACE_ACCOUNT_ID_VAR) ??
    c.req.param('workspaceId') ??
    c.req.param('accountId')) as string;
}
