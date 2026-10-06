import { accountMembers } from "@kortix/db";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { profileNameFromMetadata } from "../accounts/core/account-name";
import { bootstrapPersonalAccount } from "../accounts/core/bootstrap-personal-account";
import { syncLegacyStripeSubscription } from "../billing/services/legacy-stripe-sync";
import { db } from "./db";
import {
  IMPERSONATION_INVALID_CODE,
  impersonatedAccountFor,
} from "./impersonation";
import { getSupabase } from "./supabase";
import { ttlMemo } from "./ttl-memo";
import { withTimeout } from "./with-timeout";

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
    if (result.status === "error") {
      console.warn(
        `[resolve-account] Stripe sync error for ${accountId}: ${result.error}`,
      );
    }
  },
});

async function syncLegacySubscription(accountId: string): Promise<void> {
  try {
    await withTimeout(
      syncLegacySubscriptionThrottled(accountId),
      1_500,
      "legacy-stripe-sync",
    );
  } catch {
    // Timeout or sync failure — never block account resolution on recovery.
  }
}

/**
 * The account a billing request targets, from plain values: the caller's user
 * id and the `account_id` the request named (query or body), if any. The HTTP
 * reader is `resolveScopedAccountId` in `middleware/resolve-account.ts`.
 *
 *   1. A named account → verify the caller is a member of it, then return it.
 *      403 on miss.
 *   2. Otherwise `resolveAccountId(userId)` — the user's primary membership.
 */
export async function scopedAccountIdFor(
  userId: string,
  requested: string | undefined,
): Promise<string> {
  // Acting as an account: the target IS the scope. An explicit `account_id`
  // that disagrees is refused rather than honoured — a console still holding a
  // stale account id must not be able to steer a write out of the account the
  // banner says the operator is inside.
  const impersonated = impersonatedAccountFor(userId);
  if (impersonated) {
    if (requested && requested !== impersonated) {
      throw new HTTPException(403, {
        message: "Impersonated requests cannot target another account",
        res: new Response(
          JSON.stringify({
            error: "Impersonated requests cannot target another account",
            code: IMPERSONATION_INVALID_CODE,
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      });
    }
    return impersonated;
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
      message: "Not a member of the requested account",
    });
  }

  return requested;
}

export async function resolveAccountId(userId: string): Promise<string> {
  // Impersonation is resolved BEFORE the membership lookup, not after: the
  // operator has no `account_members` row in the target account, so falling
  // through would return their OWN account and quietly mis-scope every write
  // the console believes it is making on the customer's behalf.
  //
  // The legacy-Stripe recovery sync below is deliberately skipped for an
  // impersonated read — it is a write side effect on the customer's billing
  // state, and an operator opening an account to look at it must not mutate it.
  const impersonated = impersonatedAccountFor(userId);
  if (impersonated) return impersonated;

  // NOTE: a failing membership lookup must THROW, not fall through — silently
  // treating a DB error as "no membership" would mis-scope a multi-account
  // user to their personal account id below.
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
    // Resolve the signup email and profile name so the account gets a real,
    // suggested name ("Ada's workspace" — never the email, KRTX-638). A
    // token-authed caller reaches here with userId == an existing account_id,
    // which is not an auth user — the lookup misses and the placeholder
    // fallback inside bootstrapPersonalAccount still applies (the insert is a
    // conflict no-op for those anyway).
    let email: string | null = null;
    let fullName: string | null = null;
    try {
      const { data } = await getSupabase().auth.admin.getUserById(userId);
      email = data?.user?.email ?? null;
      fullName = profileNameFromMetadata(data?.user?.user_metadata);
    } catch {
      /* name falls back to the email-derived suggestion */
    }
    await bootstrapPersonalAccount(userId, email, fullName);
  } catch (err) {
    console.warn("[resolve-account] Failed to initialize first account:", err);
  }

  return userId;
}
