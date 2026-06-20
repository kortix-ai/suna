import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { accounts, accountMembers, accountUser } from '@kortix/db';
import { db } from './db';
import { ttlMemo } from './ttl-memo';
import { withTimeout } from './with-timeout';
import { syncLegacyStripeSubscription } from '../billing/services/legacy-stripe-sync';

// Legacy Stripe recovery sync — throttled to once per account per hour and
// bounded to 1.5s on the request path.
//
// This runs on resolveAccountId — i.e. on EVERY account-agnostic billing/
// account request. When the account has canonical billing state it early-exits
// on one DB read, but for accounts with a Stripe customer mapping and no
// active paid subscription it used to re-run the FULL Stripe dance every
// request (customers.search by email + retrieve + subscriptions.list per
// candidate — observed 8-12s) because a no-find persists nothing. The memo
// caches the attempt itself so at most one request per hour pays it, and the
// timeout caps what that one request pays — the sync keeps running in the
// background and its writes land for the next request. The sync is purely a
// recovery side effect (its result is never read here), so skipping the wait
// is always safe.
const syncLegacySubscriptionThrottled = ttlMemo({
  ttlMs: 60 * 60 * 1000,
  keyFn: (accountId: string) => accountId,
  loader: async (accountId: string): Promise<void> => {
    const result = await syncLegacyStripeSubscription(accountId);
    if (result.status === 'error') {
      console.warn(`[resolve-account] Stripe sync error for ${accountId}: ${result.error}`);
    }
  },
});

async function syncLegacySubscription(accountId: string): Promise<void> {
  try {
    await withTimeout(syncLegacySubscriptionThrottled(accountId), 1_500, 'legacy-stripe-sync');
  } catch {
    // Timeout or sync failure — never block account resolution on recovery.
  }
}

function defaultAccountName(): string {
  return 'Account';
}

/**
 * Resolve the account a billing request should target.
 *
 * Multi-account users (one user, multiple Kortix accounts) need every billing
 * route to be account-scoped — otherwise mutating "Subscribe" or "Manage
 * billing" or even reading "account-state" silently target the user's FIRST
 * membership, which makes /accounts/<other>?tab=billing nonsensical.
 *
 * Resolution order:
 *   1. `?account_id=` (query) or `body.account_id` if provided → verify the
 *      caller is a member of that account, then return it. 403 on miss.
 *   2. Fall back to `resolveAccountId(userId)` — the user's primary
 *      membership. Preserves legacy behaviour for surfaces that haven't
 *      been migrated to send `account_id` yet.
 *
 * Pass `source: 'body'` for POST/PUT/PATCH/DELETE routes (we read the JSON
 * body once and look for `account_id`). Pass `source: 'query'` for GETs.
 */
export async function resolveScopedAccountId(
  c: any,
  source: 'query' | 'body' = 'query',
): Promise<string> {
  const userId = c.get('userId') as string;

  let requested: string | undefined;
  if (source === 'query') {
    requested = c.req.query('account_id');
  } else {
    try {
      // Use Hono's cached body parse (c.req.json()), NOT c.req.raw.clone().json():
      // under @hono/zod-openapi the request-validation middleware consumes the raw
      // body stream before the handler runs, so a clone of c.req.raw is empty by
      // then → account_id would be missed → a non-member would resolve to their
      // own account instead of being 403'd. c.req.json() returns the cached parse.
      const body = await c.req.json();
      const candidate = body?.account_id;
      if (typeof candidate === 'string' && candidate) requested = candidate;
    } catch {
      // No JSON body or malformed — that's fine, fall through.
    }
  }

  if (!requested) {
    return resolveAccountId(userId);
  }

  const [member] = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.userId, userId),
        eq(accountMembers.accountId, requested),
      ),
    )
    .limit(1);

  if (!member) {
    throw new HTTPException(403, {
      message: 'Not a member of the requested account',
    });
  }

  return requested;
}

export async function resolveAccountId(userId: string): Promise<string> {
  try {
    const [membership] = await db
      .select({ accountId: accountMembers.accountId })
      .from(accountMembers)
      .where(eq(accountMembers.userId, userId))
      // Deterministic "primary account" = the user's earliest-joined account
      // (their original). No personal/team flag — there is no such thing now;
      // a bare (account-agnostic) lookup must be stable, not pick-whatever-row.
      .orderBy(accountMembers.joinedAt)
      .limit(1);

    if (membership) {
      await syncLegacySubscription(membership.accountId);
      return membership.accountId;
    }
  } catch { }

  try {
    const [legacy] = await db
      .select({ accountId: accountUser.accountId })
      .from(accountUser)
      .where(eq(accountUser.userId, userId))
      .limit(1);

    if (legacy) {
      try {
        await db.insert(accounts).values({
          accountId: legacy.accountId,
          name: defaultAccountName(),
        }).onConflictDoNothing();

        await db.insert(accountMembers).values({
          userId,
          accountId: legacy.accountId,
          accountRole: 'owner',
          isSuperAdmin: true,
        }).onConflictDoNothing();

        console.log(`[resolve-account] Lazy-migrated basejump account ${legacy.accountId} for user ${userId}`);
      } catch (migErr) {
        console.warn(`[resolve-account] Lazy migration failed for ${legacy.accountId}:`, migErr);
      }

      await syncLegacySubscription(legacy.accountId);

      return legacy.accountId;
    }
  } catch { }

  // First-time signup → create the user's personal account (id == userId) and a
  // self-membership. Pending account invitations are auto-claimed on the first
  // /v1/accounts call (see accounts/index.ts:autoClaimPendingInvites).
  //
  // GUARD: only self-provision the membership when we ACTUALLY created the
  // account. Kortix tokens (PAT/session/sandbox) map accountId→userId in the auth
  // middleware (middleware/auth.ts: `c.set('userId', result.accountId)`), so a
  // token-authed caller reaches here with `userId` == an EXISTING account_id.
  // Without this guard we'd insert a phantom account_members row
  // (user_id == account_id, owner, super) — a "shadow user" that shows as a bare
  // UUID in the members list (no auth email) AND inflates the per-seat count
  // (countActiveMembers). Creating the membership only on a fresh account keeps
  // genuine new-user signup working while never minting a self-membership for an
  // account that already exists.
  try {
    const createdAccount = await db.insert(accounts).values({
      accountId: userId,
      name: defaultAccountName(),
    }).onConflictDoNothing().returning({ accountId: accounts.accountId });

    if (createdAccount.length > 0) {
      await db.insert(accountMembers).values({
        userId,
        accountId: userId,
        accountRole: 'owner',
        isSuperAdmin: true,
      }).onConflictDoNothing();
    }
  } catch { }

  return userId;
}
