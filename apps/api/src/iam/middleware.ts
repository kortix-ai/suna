// Hono middleware that gates routes on a specific IAM action.
//
// Usage:
//   app.get('/v1/accounts/:id/groups', requirePermission('group.read'), handler);
//
//   app.post(
//     '/v1/accounts/:id/projects/:projectId/trigger',
//     requirePermission('project.session.start', (c) => ({
//       type: 'project',
//       id: c.req.param('projectId')!,
//     })),
//     handler,
//   );
//
// Assumes prior middleware has populated `userId` and an `accountId` resolver
// is available either from the route param or from the actor context.

import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authorizeCached } from './cache';
import type { AuthorizeTarget } from './engine';

type TargetResolver = (c: Context) => AuthorizeTarget | undefined;

/**
 * The middleware reads the account id from the request in this order:
 *   1. explicit `getAccountId(c)` override (if provided to the factory)
 *   2. `c.req.param('accountId')` or `c.req.param('id')`
 *   3. `c.get('accountId')` from earlier middleware
 *
 * Throws 400 if it can't determine an account id, 401 if no userId is set,
 * 403 if the action is denied.
 */
export function requirePermission(
  action: string,
  getTarget?: TargetResolver,
  getAccountId?: (c: Context) => string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    const userId = c.get('userId') as string | undefined;
    if (!userId) {
      throw new HTTPException(401, { message: 'authentication required' });
    }

    const accountId =
      getAccountId?.(c) ??
      c.req.param('accountId') ??
      c.req.param('id') ??
      (c.get('accountId') as string | undefined);

    if (!accountId) {
      throw new HTTPException(400, {
        message: 'unable to determine account context for permission check',
      });
    }

    const target = getTarget?.(c);
    const result = await authorizeCached(c, userId, accountId, action, target);
    if (!result.allowed) {
      throw new HTTPException(403, {
        message: `forbidden: requires ${action}`,
      });
    }
    await next();
  };
}
