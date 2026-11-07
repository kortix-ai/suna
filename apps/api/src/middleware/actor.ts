/**
 * The bridge from a Hono request to an IAM `Actor`: what the auth middleware
 * put on the context, folded into the plain values `iam/` authorizes. The
 * Actor type and the out-of-band builders (`actorForUser`, `actorForToken`, …)
 * live in `iam/actor.ts`, which re-exports these three.
 */
import type { Context } from 'hono';
import { tokenCredential, type Actor, type TokenBinding } from '../iam/actor';
import { requestClientIp } from './client-ip';
import { enforceSessionPolicy } from './session-gate';

/**
 * Build the Actor for this request from the Hono context.
 *
 * `accountId` defaults to whatever the auth branch resolved. Routes that
 * resolve a different account (the common dashboard case, where the account
 * comes from the path) pass it explicitly — the credential is unchanged, only
 * the account the verdict is asked about.
 *
 * Returns null only when the request carries no identity at all.
 */
export async function buildActor(c: Context, accountIdOverride?: string): Promise<Actor | null> {
  const userId = c.get('userId') as string | undefined;
  const accountId = accountIdOverride ?? (c.get('accountId') as string | undefined) ?? '';
  if (!userId) return null;

  const ctx = {
    ip: requestClientIp(c) ?? undefined,
    mfaAal: (c.get('mfaAal') as string | undefined) ?? undefined,
  };

  const authType = c.get('authType') as string | undefined;

  const tokenId = c.get('iamTokenId') as string | undefined;
  // A `kortix_sa_` bearer carries its own id as the token id
  // (`serviceAccountPrincipal`). A workspace key that acts as a service
  // account carries the key's row id: that one is classified from its row.
  const serviceAccountKey = authType === 'service_account' && !!tokenId && tokenId !== userId;
  if (authType === 'service_account' && !serviceAccountKey) {
    return { userId, accountId, credential: { kind: 'service_account', serviceAccountId: userId }, ctx };
  }

  if (authType === 'apiKey') {
    // Sandbox / legacy API-key bearer. auth.ts maps `userId` to the ACCOUNT id
    // for these, so there is no IAM principal behind them.
    return { userId, accountId, credential: { kind: 'sandbox' }, ctx };
  }

  // A PAT, or a workspace key that acts as a service account (an agent or bot
  // key: `authType` service_account with a token id).
  if ((authType === 'pat' || serviceAccountKey) && tokenId) {
    // The PAT branch of auth already read this token's row to validate it
    // (`patPrincipal` stores its binding fields). Same row, same request and
    // fresher than the memo, so a second `account_tokens` read is pure
    // latency: one more database round trip on every PAT request.
    const seeded = c.get('iamTokenBinding') as (TokenBinding & { tokenId: string }) | undefined;
    return {
      userId,
      accountId,
      credential: await tokenCredential(
        tokenId,
        accountId,
        (c.get('sessionId') as string | undefined) ?? null,
        seeded?.tokenId === tokenId ? seeded : undefined,
      ),
      ctx,
    };
  }

  // An OAuth access token whose consent named one workspace
  // (middleware/auth-oauth.ts sets `tokenProjectId`): the engine confines it
  // like a workspace key, so the route fence is not its only wall.
  if (authType === 'oauth') {
    const boundWorkspaceId = c.get('tokenProjectId') as string | undefined;
    if (boundWorkspaceId) return { userId, accountId, credential: { kind: 'jwt', boundWorkspaceId }, ctx };
  }

  return { userId, accountId, credential: { kind: 'jwt' }, ctx };
}

/**
 * The request's Actor, rebuilt when a route asks about a DIFFERENT account than
 * the one auth resolved. The cached actor on the context is the common case
 * (PAT/service-account requests, where auth already knew the account).
 */
export async function actorFor(c: Context, accountId: string): Promise<Actor | null> {
  const cached = c.get('actor') as Actor | undefined;
  if (cached && cached.accountId === accountId) return cached;
  return buildActor(c, accountId);
}

/**
 * THE gate helper: the actor for this request, asked about this account.
 *
 * Every route-level authorization call takes its actor from here, so "I forgot
 * the credential" is not expressible — there is no overload that omits it and
 * no nullable to fall through.
 *
 * It never returns null. A request that carries no identity at all yields an
 * actor with an EMPTY user id, which resolves to no principal and is denied
 * `not_a_member` by every gate. That is deliberately the same outcome as
 * before: `authorizeV2` was handed an undefined userId, reached the engine, and
 * denied there. Turning it into a 401 here would change a 403 into a 401 on
 * every route at once, which is a contract change, not a refactor.
 */
export async function actorOf(c: Context, accountId: string): Promise<Actor> {
  // The account's session policy (max lifetime, idle timeout, force-logout)
  // covers EVERY route that authorizes against it, not only the account
  // subtrees (design.md §3.2 C4, finding 12): a revoked browser session gets
  // `401 session_token_revoked` here. Memoized per request and account, and
  // run beside the actor build so it adds no depth.
  const [actor] = await Promise.all([actorFor(c, accountId), enforceSessionPolicy(c, accountId)]);
  return actor ?? { userId: '', accountId, credential: { kind: 'jwt' }, ctx: {} };
}
