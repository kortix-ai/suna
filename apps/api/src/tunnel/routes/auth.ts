import { HTTPException } from 'hono/http-exception';
import { and, eq, or } from 'drizzle-orm';
import { accountMembers, tunnelConnections } from '@kortix/db';
import { resolveAccountId } from '../../shared/resolve-account';
import { db } from '../../shared/db';

/**
 * Tunnel auth model — two tiers:
 *
 *   • READ / EXECUTE (getTunnelReadContext) — listing connections and relaying
 *     RPCs. Allowed for interactive users, account PATs, and account API keys.
 *     Project PATs, sandbox keys, and service accounts must use the Computer Tunnel
 *     connector gateway so profile assignments, grants, and tool policy apply.
 *
 *   • MANAGE (getTunnelOwnerContext) — create/delete/rename connections, grant/
 *     revoke permissions, approve device-auth, rotate tokens. These mutate the
 *     security posture of a real machine, so they require a USER credential
 *     (interactive session / PAT), never a long-lived non-human principal
 *     like a sandbox apiKey or service-account bearer.
 */

/** Allow only human credentials — used to fence off tunnel management. */
export function requireUserCredential(c: any): void {
  const authType = c.get('authType');
  if (authType !== 'supabase' && authType !== 'pat') {
    throw new HTTPException(403, {
      message: 'User credentials are required for tunnel management',
    });
  }
}

/**
 * Resolve the account + ownership clause for direct tunnel READ / RPC access.
 * Account API keys have accountId without userId. Project and service
 * credentials fail before ownership resolution.
 */
export async function getTunnelReadContext(c: any) {
  const authType = c.get('authType') as string | undefined;
  const isSandboxCredential = authType === 'apiKey' && Boolean(c.get('sandboxId'));
  const isProjectPat = authType === 'pat' && Boolean(c.get('tokenProjectId'));
  if (isSandboxCredential || isProjectPat || authType === 'service_account') {
    throw new HTTPException(403, {
      message:
        'Project and service credentials must use a Computer Tunnel connector profile for tunnel access',
    });
  }

  const userId = c.get('userId') as string | undefined;
  const ctxAccountId = c.get('accountId') as string | undefined;
  const accountId = ctxAccountId || (userId ? await resolveAccountId(userId) : undefined);

  if (!accountId) {
    throw new HTTPException(401, {
      message: 'Unable to resolve an account for tunnel access',
    });
  }

  if (userId && userId !== accountId) {
    const [membership] = await db
      .select({ accountRole: accountMembers.accountRole })
      .from(accountMembers)
      .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
      .limit(1);

    if (membership?.accountRole !== 'owner' && membership?.accountRole !== 'admin') {
      // Raw tunnel routes bypass connector grants and tool policies. A regular
      // member can use an assigned Computer Tunnel profile, but receives no implicit
      // access to the organization's full machine fleet.
      return {
        userId,
        accountId: userId,
        authorizedAccountIds: [userId],
        ownerClause: eq(tunnelConnections.accountId, userId),
      };
    }
  }

  // Owners and admins can access the organization fleet and their personal
  // machines. Account API keys have no userId and access only their account.
  const ownerClause =
    userId && userId !== accountId
      ? or(eq(tunnelConnections.accountId, accountId), eq(tunnelConnections.accountId, userId))
      : eq(tunnelConnections.accountId, accountId);

  const authorizedAccountIds = userId && userId !== accountId ? [accountId, userId] : [accountId];

  return { userId, accountId, authorizedAccountIds, ownerClause };
}

/**
 * Resolve the account + ownership clause for tunnel MANAGEMENT. Same as the
 * read context, but first rejects non-human credentials.
 */
export async function getTunnelOwnerContext(c: any) {
  requireUserCredential(c);
  return getTunnelReadContext(c);
}
