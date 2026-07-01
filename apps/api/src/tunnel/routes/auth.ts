import { HTTPException } from 'hono/http-exception';
import { Effect, Either } from 'effect';
import { eq, or } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import { resolveAccountId } from '../../shared/resolve-account';
import { attemptTunnel, attemptTunnelSync } from './effect-workflows';

async function runAuthEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isRight(result)) return result.right;
  throw result.left;
}

/**
 * Tunnel auth model — two tiers:
 *
 *   • READ / EXECUTE (getTunnelReadContext) — listing connections and relaying
 *     RPCs. Allowed for ANY credential scoped to the owning account, including
 *     the sandbox's `apiKey` (KORTIX_TOKEN). The cloud agent runs as an apiKey
 *     and must be able to resolve its account's tunnel and drive it. RPC is
 *     itself permission-gated, so this stays safe.
 *
 *   • MANAGE (getTunnelOwnerContext) — create/delete/rename connections, grant/
 *     revoke permissions, approve device-auth, rotate tokens. These mutate the
 *     security posture of a real machine, so they require a USER credential
 *     (interactive session / PAT), never a long-lived sandbox apiKey.
 */

/** Reject sandbox/apiKey credentials — used to fence off tunnel management. */
export function requireUserCredential(c: any): void {
  if (c.get('authType') === 'apiKey') {
    throw new HTTPException(403, {
      message: 'User credentials are required for tunnel management',
    });
  }
}

export const requireUserCredentialEffect = (c: any) =>
  attemptTunnelSync(() => requireUserCredential(c));

/**
 * Resolve the account + ownership clause for tunnel READ / RPC access. Works
 * for both user credentials (userId set) and the sandbox apiKey (accountId set,
 * userId absent). Does NOT require a user credential.
 */
export const getTunnelReadContextEffect = (c: any) =>
  Effect.gen(function* () {
    const userId = c.get('userId') as string | undefined;
    const ctxAccountId = c.get('accountId') as string | undefined;
    const accountId = ctxAccountId || (userId
      ? yield* attemptTunnel(() => resolveAccountId(userId))
      : undefined);

    if (!accountId) {
      return yield* Effect.fail(
        new HTTPException(401, {
          message: 'Unable to resolve an account for tunnel access',
        }),
      );
    }

    // Personal-account installs store the tunnel under the user id; team accounts
    // under the account id. Match either when they differ.
    const ownerClause = userId && userId !== accountId
      ? or(eq(tunnelConnections.accountId, accountId), eq(tunnelConnections.accountId, userId))
      : eq(tunnelConnections.accountId, accountId);

    return { userId, accountId, ownerClause };
  });

export async function getTunnelReadContext(c: any) {
  return runAuthEffect(getTunnelReadContextEffect(c));
}

/**
 * Resolve the account + ownership clause for tunnel MANAGEMENT. Same as the
 * read context, but first rejects apiKey credentials.
 */
export const getTunnelOwnerContextEffect = (c: any) =>
  Effect.gen(function* () {
    yield* requireUserCredentialEffect(c);
    return yield* getTunnelReadContextEffect(c);
  });

export async function getTunnelOwnerContext(c: any) {
  return runAuthEffect(getTunnelOwnerContextEffect(c));
}
