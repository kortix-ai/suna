/**
 * WRITE OWNERSHIP for `credit_accounts`.
 *
 * One row, two writers, and until now no boundary between them:
 *
 *   - the BILLING PROVIDER sync (Stripe + RevenueCat webhooks, the legacy
 *     Stripe backfill) reconciles what the customer is paying for;
 *   - an OPERATOR (admin routes, trial issue/revoke) records intent the
 *     provider knows nothing about — a contracted Enterprise entitlement, a
 *     managed-models override, a raised session cap, an issued trial.
 *
 * They collided on `tier`. An operator sets `enterprise_entitled` (or, on the
 * older path, `tier='enterprise'`); the next `customer.subscription.updated`
 * writes `tier = resolvedTier` straight back and the account silently loses
 * SSO/SCIM/RBAC/audit. The guard that used to live inline in
 * `syncSubscriptionState` covered exactly ONE branch of ONE handler (a per-seat
 * item on a paying subscription). Every other tier write — the price-resolved
 * tier, the never-paid reset, `revertToFree`, the scheduled downgrade, the
 * RevenueCat expiry — still clobbered.
 *
 * This module is the chokepoint. Both writers declare which side they are on,
 * and the rules are enforced here instead of being re-derived at 14 call sites:
 *
 *   - `applyStripeSync`  — THROWS if the patch touches an admin-owned field or
 *     tries to write `tier='enterprise'`; SKIPS the `tier` key (and only that
 *     key) when the account is admin-pinned. Everything else it carries is
 *     factual provider bookkeeping and is always applied.
 *   - `applyAdminOverride` — THROWS if the patch touches a provider-owned
 *     field. `tier` is the one deliberate exception (support ops reassign
 *     plans), and it still may never be `'enterprise'`.
 *
 * Wallet and credit-bookkeeping columns (balances, lifetime totals, auto-topup,
 * grant timestamps) are on NEITHER list on purpose: both writers legitimately
 * move money, and money flows through `grantCredits`/`resetExpiringCredits`
 * anyway, which have their own idempotency contract.
 *
 * Naming: the provider-side verb is `applyStripeSync` because Stripe is the
 * writer that caused the damage, but the boundary it enforces is
 * PROVIDER-vs-ADMIN — the RevenueCat handlers use it too, and `revenuecat*`
 * columns are provider-owned.
 */

import type { creditAccounts } from '@kortix/db';
import {
  getCreditAccount,
  updateCreditAccount,
  upsertCreditAccount,
} from '../repositories/credit-accounts';
import { invalidateAccountBilling } from './billing-cache';

export type AccountPatch = Partial<typeof creditAccounts.$inferInsert>;

/**
 * Columns that describe what the billing provider says is true. Only a
 * provider-sync writer may set them.
 *
 * `tier` heads the list because it is the field the whole module exists for:
 * it is an ENTITLEMENT derived from a subscription, and an operator can pin it
 * out of the provider's reach (see `accountIsAdminPinned`).
 */
export const STRIPE_OWNED_FIELDS = [
  'tier',
  'billingModel',
  'seatCount',
  'seatSubscriptionItemId',
  'stripeSubscriptionId',
  'stripeSubscriptionStatus',
  'billingCycleAnchor',
  'planType',
  'provider',
  'paymentStatus',
  'lastPaymentFailure',
  'commitmentType',
  'commitmentStartDate',
  'commitmentEndDate',
  'commitmentPriceId',
  'canCancelAfter',
  'scheduledTierChange',
  'scheduledTierChangeDate',
  'scheduledPriceId',
  'lastProcessedInvoiceId',
  'lastRenewalPeriodStart',
  'revenuecatCustomerId',
  'revenuecatSubscriptionId',
  'revenuecatProductId',
  'revenuecatCancelledAt',
  'revenuecatCancelAtPeriodEnd',
  'revenuecatPendingChangeProduct',
  'revenuecatPendingChangeDate',
  'revenuecatPendingChangeType',
] as const;

/**
 * Columns that record operator intent. No provider webhook may set them — a
 * patch that tries is a bug in the caller, not a value to be filtered out, so
 * it throws rather than being silently dropped.
 */
export const ADMIN_OWNED_FIELDS = [
  'enterpriseEntitled',
  'demoEnterprise',
  'managedModelsOverride',
  'maxConcurrentSessions',
  'trialStatus',
  'trialTier',
  'trialSeats',
  'trialStartedAt',
  'trialEndsAt',
  'trialNote',
  'trialGrantedBy',
] as const;

/**
 * Provider-owned columns an admin MAY still write.
 *
 * Exactly one: `tier`. Support reassigns a plan by hand often enough
 * (comped account, botched migration, refund) that removing the ability would
 * just push operators to raw SQL, which no cache invalidation or audit trail
 * observes. It is still never `'enterprise'` — that is an entitlement flag,
 * not a tier (see `assertTierIsNotEnterprise`).
 */
export const ADMIN_ASSIGNABLE_FIELDS = ['tier'] as const;

const STRIPE_OWNED: ReadonlySet<string> = new Set(STRIPE_OWNED_FIELDS);
const ADMIN_OWNED: ReadonlySet<string> = new Set(ADMIN_OWNED_FIELDS);
const ADMIN_ASSIGNABLE: ReadonlySet<string> = new Set(ADMIN_ASSIGNABLE_FIELDS);

/** A patch crossed the ownership boundary. Always a caller bug. */
export class AccountWriteOwnershipError extends Error {
  readonly name = 'AccountWriteOwnershipError';
  readonly fields: string[];

  constructor(message: string, fields: string[]) {
    super(message);
    this.fields = fields;
  }
}

/** The subset of a `credit_accounts` row the pin rule reads. */
export type PinnableAccount = {
  tier?: string | null;
  enterpriseEntitled?: boolean | null;
} | null;

/**
 * Is this account's tier owned by an operator rather than by the provider?
 *
 * Two shapes qualify, and both are in production:
 *   - `enterprise_entitled = true` — the current primitive. A contracted cloud
 *     Enterprise deal whose entitlements are independent of what Stripe bills.
 *   - `tier = 'enterprise'` — the older sales-assignment. The admin tier route
 *     refuses to create new ones (400), but existing rows still carry it and
 *     must not be downgraded by a webhook.
 *
 * A pinned account still reconciles every other provider fact —
 * `billing_model`, `seat_count`, subscription status, seat grants. Only `tier`
 * is off-limits, which is exactly the split a deal that is BOTH Enterprise
 * (entitlements) AND per-seat (billing) needs.
 */
export function accountIsAdminPinned(account: PinnableAccount): boolean {
  if (!account) return false;
  return account.enterpriseEntitled === true || account.tier === 'enterprise';
}

export interface StripeSyncContext {
  /**
   * The `credit_accounts` row the caller already read. Supplying it skips the
   * pin lookup. `null` means "this account has no row"; omit the key entirely
   * to have the pin check fetch it.
   */
  account?: PinnableAccount;
  /**
   * `'upsert'` (default) creates the row when it is missing. `'update'` is a
   * no-op on a missing row — the correct choice for handlers that must never
   * conjure a billing row out of an event, e.g. `invoice.payment_failed`.
   */
  mode?: 'upsert' | 'update';
  /** Short label for the log line, e.g. `'customer.subscription.updated'`. */
  reason?: string;
}

export interface AdminActor {
  /** The operator's user id, when the write came from an authenticated route. */
  userId?: string | null;
  /** Audit-style label for the log line, e.g. `'admin.account.tier.set'`. */
  action: string;
}

function violations(patch: AccountPatch, forbidden: ReadonlySet<string>): string[] {
  return Object.keys(patch).filter((key) => forbidden.has(key));
}

/**
 * `enterprise` is an entitlement, not a tier. A `tier='enterprise'` write is
 * clobbered by the next subscription sync, so accepting one hands the caller a
 * change that silently reverts. Both writers refuse it.
 */
function assertTierIsNotEnterprise(patch: AccountPatch, writer: string): void {
  if (patch.tier === 'enterprise') {
    throw new AccountWriteOwnershipError(
      `${writer}: refusing to write tier='enterprise' — enterprise is an entitlement (enterprise_entitled), not a tier`,
      ['tier'],
    );
  }
}

/**
 * Write provider-derived billing state.
 *
 * Throws when the patch reaches into admin-owned territory. Drops the `tier`
 * key — and nothing else — when the account is admin-pinned.
 */
export async function applyStripeSync(
  accountId: string,
  patch: AccountPatch,
  ctx: StripeSyncContext = {},
): Promise<void> {
  const foreign = violations(patch, ADMIN_OWNED);
  if (foreign.length > 0) {
    throw new AccountWriteOwnershipError(
      `applyStripeSync: refusing to write admin-owned field(s) ${foreign.join(', ')} for ${accountId} — route this through applyAdminOverride (or a narrow cross-domain helper) instead`,
      foreign,
    );
  }
  assertTierIsNotEnterprise(patch, 'applyStripeSync');

  const next: AccountPatch = { ...patch };
  const label = ctx.reason ? ` (${ctx.reason})` : '';

  if ('tier' in next) {
    const account = 'account' in ctx ? ctx.account : await getCreditAccount(accountId);
    if (accountIsAdminPinned(account ?? null)) {
      console.warn(
        `[write-owner] applyStripeSync${label}: skipping tier='${String(next.tier)}' for ${accountId} — the account is admin-pinned (enterprise_entitled=${String(account?.enterpriseEntitled ?? false)}, tier='${String(account?.tier ?? null)}'). Every other provider field is still applied.`,
      );
      delete next.tier;
    }
  }

  if (Object.keys(next).length === 0) {
    console.warn(
      `[write-owner] applyStripeSync${label}: nothing left to write for ${accountId} after the pin rule — skipping the write.`,
    );
    return;
  }

  if (ctx.mode === 'update') {
    await updateCreditAccount(accountId, next);
  } else {
    await upsertCreditAccount(accountId, next);
  }

  invalidateAccountBilling(accountId);
}

/**
 * Write operator intent.
 *
 * Throws when the patch reaches into provider-owned territory, except for the
 * one field an admin may legitimately assign (`tier`).
 */
export async function applyAdminOverride(
  accountId: string,
  patch: AccountPatch,
  actor: AdminActor,
): Promise<void> {
  const foreign = violations(patch, STRIPE_OWNED).filter((key) => !ADMIN_ASSIGNABLE.has(key));
  if (foreign.length > 0) {
    throw new AccountWriteOwnershipError(
      `applyAdminOverride: refusing to write provider-owned field(s) ${foreign.join(', ')} for ${accountId} — those are reconciled from the billing provider by applyStripeSync`,
      foreign,
    );
  }
  assertTierIsNotEnterprise(patch, 'applyAdminOverride');

  if (Object.keys(patch).length === 0) return;

  await upsertCreditAccount(accountId, patch);
  invalidateAccountBilling(accountId);

  console.log(
    `[write-owner] applyAdminOverride: ${actor.action} on ${accountId} by ${actor.userId ?? 'system'} → ${Object.keys(patch).join(', ')}`,
  );
}
