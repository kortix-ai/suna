import { HTTPException } from 'hono/http-exception';
import { and, eq, or } from 'drizzle-orm';
import { accountMembers, tunnelConnections } from '@kortix/db';
import {
  isImpersonatingAccount,
  isImpersonationBlockedAccount,
} from '../../shared/impersonation';
import { resolveAccountId } from '../../shared/resolve-account';
import { db } from '../../shared/db';
import { accountRoleFor, isAccountManagerRole } from '../../iam/read-models';

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

  // ACT-AS: this resolver reads `account_members` DIRECTLY rather than through
  // `getAccountMembership`, so it does not see the impersonation branch — the
  // operator has no membership row in the customer's account, the probe below
  // finds nothing, and the fall-back silently re-points the request at
  // `accountId: userId`, the OPERATOR's own fleet. That is the one thing this
  // feature refuses to do: a delete or a token rotation would hit the
  // operator's own machines while the banner, the audit `accountId` and the
  // `admin.impersonate.action` row all name the customer. Fail closed instead.
  if (isImpersonationBlockedAccount(userId, accountId)) {
    throw new HTTPException(403, {
      message: 'Impersonated requests cannot target another account',
    });
  }
  const impersonatingThisAccount = isImpersonatingAccount(userId, accountId);

  if (userId && userId !== accountId && !impersonatingThisAccount) {
    const accountRole = await accountRoleFor(accountId, userId);

    if (!isAccountManagerRole(accountRole)) {
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
  //
  // The personal-machines half is dropped while acting as an account: the
  // operator's own `userId` is their own personal account id, so ORing it in
  // would put THEIR machines in a fleet listing the banner says belongs to the
  // customer — and, worse, inside `authorizedAccountIds`, which the RPC relay
  // authorizes against.
  const includePersonal = Boolean(userId) && userId !== accountId && !impersonatingThisAccount;
  const ownerClause = includePersonal
    ? or(eq(tunnelConnections.accountId, accountId), eq(tunnelConnections.accountId, userId!))
    : eq(tunnelConnections.accountId, accountId);

  const authorizedAccountIds = includePersonal ? [accountId, userId!] : [accountId];

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
