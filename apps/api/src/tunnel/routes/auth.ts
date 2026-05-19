import { HTTPException } from 'hono/http-exception';
import { eq, or } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import { resolveAccountId } from '../../shared/resolve-account';

export function requireUserCredential(c: any): void {
  if (c.get('authType') === 'apiKey') {
    throw new HTTPException(403, {
      message: 'User credentials are required for tunnel management',
    });
  }
}

export async function getTunnelOwnerContext(c: any) {
  requireUserCredential(c);
  const userId = c.get('userId') as string;
  const accountId = c.get('accountId') as string | undefined;
  const resolvedAccountId = accountId || await resolveAccountId(userId);
  const ownerClause = resolvedAccountId !== userId
    ? or(eq(tunnelConnections.accountId, resolvedAccountId), eq(tunnelConnections.accountId, userId))
    : eq(tunnelConnections.accountId, resolvedAccountId);

  return { userId, accountId: resolvedAccountId, ownerClause };
}
