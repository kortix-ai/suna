/**
 * WRITE OWNERSHIP for `credit_accounts`.
 *
 * One row, two writers:
 *
 *   - the BILLING PROVIDER sync (Stripe + RevenueCat webhooks) reconciles what
 *     the customer is paying for;
 *   - an OPERATOR (admin routes, trials, enterprise contracts) records intent
 *     the provider knows nothing about — an Enterprise plan, a trial, a
 *     per-feature override.
 *
 * They collide on `tier`: a subscription sync would write a Credits or Free
 * tier over an Enterprise contract. This module is the chokepoint:
 *
 *   - `applyStripeSync`  — THROWS if the patch touches an admin-owned field or
 *     tries to write `tier='enterprise'`; SKIPS the `tier` key (and only that
 *     key) when the account is on Enterprise. Everything else it carries is
 *     factual provider bookkeeping and is always applied.
 *   - `applyAdminOverride` — THROWS if the patch touches a provider-owned
 *     field, except the plan (`tier`, `planMonthlyUsd`), which operators and
 *     enterprise contracts assign.
 *
 * Wallet and credit-bookkeeping columns (balances, lifetime totals, auto-topup,
 * grant timestamps) are on NEITHER list on purpose: both writers legitimately
 * move money, and money flows through `wallet` (billing/wallet) anyway, which
 * has its own idempotency contract.
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
  'planMonthlyUsd',
  'scheduledMonthlyUsd',
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
  'maxConcurrentSessions',
  // A provider webhook has no business expressing operator intent, and a
  // whole-column write from one would erase every override at once.
  'entitlementOverrides',
  // The Enterprise layer: licensed (written by a license contract) and demo
  // (written by the account's own toggle). Never by a provider sync.
  'enterpriseEntitled',
  'demoEnterprise',
  'trialStatus',
  'trialTier',
  'trialMonthlyUsd',
  'trialStartedAt',
  'trialEndsAt',
  'trialNote',
  'trialGrantedBy',
] as const;

/**
 * Provider-owned columns an admin MAY still write.
 *
 * The plan: `tier` (including 'enterprise', the custom plan) and its monthly
 * amount. Support reassigns a plan by hand often enough
 * (comped account, botched migration, refund) that removing the ability would
 * just push operators to raw SQL, which no cache invalidation or audit trail
 * observes. Only an operator may write `'enterprise'`; the provider writer is
 * refused (`assertTierIsNotEnterprise`).
 */
export const ADMIN_ASSIGNABLE_FIELDS = ['tier', 'planMonthlyUsd'] as const;

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
export type PinnableAccount = { tier?: string | null } | null;

/**
 * Is this account's tier owned by an operator rather than by the provider?
 * Only Enterprise: it is set by a contract (`enterprise-contracts.ts`) or an
 * operator, never by a subscription sync. A pinned account still reconciles
 * every other provider fact — status, amounts, grants. Only `tier` is
 * off-limits.
 */
export function accountIsAdminPinned(account: PinnableAccount): boolean {
  return account?.tier === 'enterprise';
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
 * A subscription sync never grants Enterprise: only a contract or an operator
 * does, through `applyAdminOverride`.
 */
function assertTierIsNotEnterprise(patch: AccountPatch, writer: string): void {
  if (patch.tier === 'enterprise') {
    throw new AccountWriteOwnershipError(
      `${writer}: refusing to write tier='enterprise' — Enterprise is set by a contract or an operator, never by a subscription sync`,
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
        `[write-owner] applyStripeSync${label}: skipping tier='${String(next.tier)}' for ${accountId} — the account is on Enterprise. Every other provider field is still applied.`,
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
  // An operator MAY assign `tier='enterprise'`: that is how a custom plan is
  // made. The provider writer still may not (assertTierIsNotEnterprise in
  // applyStripeSync), and the pin below keeps a later Stripe sync off it.

  if (Object.keys(patch).length === 0) return;

  await upsertCreditAccount(accountId, patch);
  invalidateAccountBilling(accountId);

  console.log(
    `[write-owner] applyAdminOverride: ${actor.action} on ${accountId} by ${actor.userId ?? 'system'} → ${Object.keys(patch).join(', ')}`,
  );
}
