import type { Effect } from 'effect';
import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getPlatformRole } from '../shared/platform-roles';

export async function requireAdmin(c: Context, next: Next) {
  const accountId = c.get('userId') as string | undefined;
  if (!accountId) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }

  const role = await getPlatformRole(accountId);
  if (role !== 'admin' && role !== 'super_admin') {
    throw new HTTPException(403, { message: 'Admin access required' });
  }

  c.set('platformRole', role);
  await next();
}
