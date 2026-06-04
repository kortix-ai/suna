import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { accounts, accountMembers, accountUser } from '@kortix/db';
import { db } from './db';

async function syncLegacySubscription(accountId: string): Promise<void> {
  const { syncLegacyStripeSubscription } = await import('../billing/services/legacy-stripe-sync');
  const result = await syncLegacyStripeSubscription(accountId);
  if (result.status === 'error') {
    console.warn(`[resolve-account] Stripe sync error for ${accountId}: ${result.error}`);
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
          personalAccount: true,
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

  // First-time signup. Pending account invitations are auto-claimed on the
  // first /v1/accounts call (see accounts/index.ts:autoClaimPendingInvites)
  // — no sandbox-scoped invite claim needed anymore.
  try {
    await db.insert(accounts).values({
      accountId: userId,
      name: defaultAccountName(),
      personalAccount: true,
    }).onConflictDoNothing();

    await db.insert(accountMembers).values({
      userId,
      accountId: userId,
      accountRole: 'owner',
      isSuperAdmin: true,
    }).onConflictDoNothing();
  } catch { }

  return userId;
}
