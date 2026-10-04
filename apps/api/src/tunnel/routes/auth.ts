import { HTTPException } from 'hono/http-exception';
import { and, eq, isNull, or } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import {
  isImpersonatingAccount,
  isImpersonationBlockedAccount,
} from '../../iam/impersonation';
import { resolveAccountId } from '../../accounts/resolve-account';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { accountRoleFor, isAccountManagerRole } from '../../iam/read-models';

/**
 * Tunnel auth model — which machines a caller may see and manage directly.
 *
 *   • A machine belongs to the human who paired it (`owner_user_id`). Only that
 *     human sees, renames, unpairs, or relays to it here.
 *   • Machines paired before owners existed under a team account have no
 *     owner; the account's managers (owner/admin) manage those.
 *
 * Projects reach machines only through computer ACCOUNTS on the `computer`
 * connector (the connector gateway), never through these routes. Project and
 * service credentials are refused here.
 *
 * Mutating routes (rename, unpair, rotate, approve a pairing) additionally
 * require a USER credential (interactive session / PAT), never a long-lived
 * non-human principal.
 */

/**
 * Allow only human credentials — used to fence off tunnel management. A
 * session or agent token carries its creator's user id; accepting it would
 * let an agent pair, share, or unpair that human's computer.
 */
export function requireUserCredential(c: any): void {
  const authType = c.get('authType');
  if ((authType !== 'supabase' && authType !== 'pat') || isProjectSessionPrincipal(c)) {
    throw new HTTPException(403, {
      message: 'User credentials are required for tunnel management',
    });
  }
}

/**
 * Resolve the account + the machines this caller may reach directly.
 * Account API keys have accountId without userId: they see the account's
 * owner-less machines only.
 */
export async function getTunnelReadContext(c: any) {
  const authType = c.get('authType') as string | undefined;
  const isSandboxCredential = authType === 'apiKey' && Boolean(c.get('sandboxId'));
  const isProjectPat = authType === 'pat' && Boolean(c.get('tokenProjectId'));
  if (isSandboxCredential || isProjectPat || authType === 'service_account') {
    throw new HTTPException(403, {
      message: 'Project and service credentials reach computers through the computer connector',
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

  // ACT-AS: the operator has no membership in the customer's account, and
  // their own machines must never appear in (or be mutated through) a request
  // the banner attributes to the customer. Fail closed on a foreign account;
  // on the impersonated account show only its owner-less team machines.
  if (isImpersonationBlockedAccount(userId, accountId)) {
    throw new HTTPException(403, {
      message: 'Impersonated requests cannot target another account',
    });
  }
  const teamMachines = and(eq(tunnelConnections.accountId, accountId), isNull(tunnelConnections.ownerUserId));
  if (!userId || isImpersonatingAccount(userId, accountId)) {
    return { userId, accountId, ownerClause: teamMachines! };
  }

  const own = eq(tunnelConnections.ownerUserId, userId);
  const manager =
    userId === accountId || isAccountManagerRole(await accountRoleFor(accountId, userId));
  return { userId, accountId, ownerClause: manager ? or(own, teamMachines)! : own };
}

/**
 * Resolve the account + ownership clause for tunnel MANAGEMENT. Same as the
 * read context, but first rejects non-human credentials.
 */
export async function getTunnelOwnerContext(c: any) {
  requireUserCredential(c);
  return getTunnelReadContext(c);
}
