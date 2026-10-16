import { createHostedCheckout } from './hosted-checkout';
/**
 * Enterprise license contracts: an annual license fee that turns the
 * Enterprise features on (`enterprise_entitled`). No credits come with it
 * (.agents/skills/billing/references/plans-and-access.md, "License contracts").
 *
 *   offer ──accept (Stripe Checkout)──┐
 *   invoice (Stripe sends it) ────────┼─► active ──end / Stripe deleted / term over──► ended
 *   manual (paid outside Stripe) ─────┘
 *
 * The contract is the only writer of `enterprise_entitled`, through
 * `applyAdminOverride`: a license is operator intent, even when Stripe delivers
 * the payment that activates it. The billing plan is never touched.
 */
import { logger } from '../../lib/logger';
import { enterpriseContracts } from '@kortix/db';
import { and, desc, eq, isNotNull, lte } from 'drizzle-orm';
import Stripe from 'stripe';
import { BillingError } from '../../errors';
import { accountRoleMap } from '../../iam/read-models';
import { lookupEmailsByUserIds } from '../../accounts/core/owner-emails';
import { clearAccountLimitCache } from '../../shared/account-limits';
import { db } from '../../shared/db';
import { getStripe } from '../../shared/stripe';
import { getCreditAccount } from '../repositories/credit-accounts';
import { applyAdminOverride } from './account-write-owner';
import { mergeOverridePatch, toStoredOverrides } from './entitlement-overrides';
import { invalidateCachedAccountTier } from './entitlements';
import { ACCESS_GRACE_DAYS } from './resolve-billing';
import { getOrCreateStripeCustomer } from './subscriptions';

export type ContractRow = typeof enterpriseContracts.$inferSelect;
export type ContractCollection = 'checkout' | 'invoice' | 'manual';
export type ContractEndReason = 'operator' | 'term_over' | 'stripe_subscription_deleted';

/** Largest license or credit amount one contract may carry, USD. */
export const MAX_CONTRACT_USD = 10_000_000;
export const MAX_CONTRACT_TERM_MONTHS = 60;
const INVOICE_DAYS_UNTIL_DUE = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A refused contract operation. The global error handler answers with `statusCode`. */
export class ContractError extends BillingError {
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message, status);
    this.name = 'ContractError';
  }
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function listContracts(accountId: string): Promise<ContractRow[]> {
  return db
    .select()
    .from(enterpriseContracts)
    .where(eq(enterpriseContracts.accountId, accountId))
    .orderBy(desc(enterpriseContracts.createdAt));
}

async function contractWithStatus(accountId: string, status: 'active' | 'offered'): Promise<ContractRow | null> {
  const [row] = await db
    .select()
    .from(enterpriseContracts)
    .where(and(eq(enterpriseContracts.accountId, accountId), eq(enterpriseContracts.status, status)))
    .limit(1);
  return row ?? null;
}

export const getActiveContract = (accountId: string) => contractWithStatus(accountId, 'active');
export const getOpenOffer = (accountId: string) => contractWithStatus(accountId, 'offered');

/**
 * The account's active contract, open offer and most recently ended contract,
 * in one query (account-state reads all three on every request).
 */
export async function getContractState(accountId: string): Promise<{
  active: ContractRow | null;
  offer: ContractRow | null;
  lastEnded: ContractRow | null;
}> {
  const rows: ContractRow[] = await db.select().from(enterpriseContracts).where(eq(enterpriseContracts.accountId, accountId));
  const endedMs = (row: ContractRow) => (row.endedAt ? new Date(row.endedAt).getTime() : 0);
  const ended = rows.filter((row) => row.status === 'ended').sort((a, b) => endedMs(b) - endedMs(a));
  return {
    active: rows.find((row) => row.status === 'active') ?? null,
    offer: rows.find((row) => row.status === 'offered') ?? null,
    lastEnded: ended[0] ?? null,
  };
}

async function getContract(id: string): Promise<ContractRow> {
  const [row] = await db.select().from(enterpriseContracts).where(eq(enterpriseContracts.id, id)).limit(1);
  if (!row) throw new ContractError('contract not found', 404);
  return row;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type CreateContractInput = {
  accountId: string;
  licenseUsd: number;
  /** Ignored: a license carries no credits (stored as 0). */
  creditsUsd?: number;
  termMonths?: number;
  collection: ContractCollection;
  note?: string | null;
  actorUserId?: string | null;
};

export function validateContractInput(input: Omit<CreateContractInput, 'accountId' | 'actorUserId'>): string | null {
  const value = input.licenseUsd;
  if (!Number.isFinite(value) || value < 0 || value > MAX_CONTRACT_USD || Math.round(value * 100) !== value * 100) {
    return `license_usd must be a USD amount in [0, ${MAX_CONTRACT_USD}] with at most 2 decimals`;
  }
  const term = input.termMonths ?? 12;
  if (!Number.isInteger(term) || term < 1 || term > MAX_CONTRACT_TERM_MONTHS) {
    return `term_months must be an integer in [1, ${MAX_CONTRACT_TERM_MONTHS}]`;
  }
  if (!['checkout', 'invoice', 'manual'].includes(input.collection)) {
    return "collection must be 'checkout', 'invoice' or 'manual'";
  }
  // Stripe bills at most every 12 months, so a Stripe-collected term is 1–12 months.
  if (input.collection !== 'manual' && term > 12) {
    return 'term_months is at most 12 for a contract collected through Stripe';
  }
  if (input.collection !== 'manual' && input.licenseUsd <= 0) {
    return 'a license collected through Stripe needs a license amount above 0';
  }
  return null;
}

function addMonths(from: Date, months: number): Date {
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

// ─── Stripe plumbing ────────────────────────────────────────────────────────

// replica-local: Stripe product ids of the two contract line items, cached per process.
const productIds = new Map<string, string>();

/**
 * The Stripe product of one contract line item, found by metadata or created
 * once. Every contract's custom yearly price hangs off these two products, so
 * revenue reports group by them.
 */
async function contractProductId(kind: 'license' | 'credits'): Promise<string> {
  const cached = productIds.get(kind);
  if (cached) return cached;
  const stripe = getStripe();
  const tag = `enterprise_${kind}`;
  const found = await stripe.products.search({ query: `metadata['kortix_product']:'${tag}'`, limit: 1 });
  const id =
    found.data[0]?.id ??
    (
      await stripe.products.create({
        name: kind === 'license' ? 'Kortix Enterprise license' : 'Kortix Enterprise credits',
        metadata: { kortix_product: tag },
      })
    ).id;
  productIds.set(kind, id);
  return id;
}

/** The yearly line items of a contract: license and credits, each skipped at $0. */
async function contractLineItems(
  contract: ContractRow,
): Promise<Array<{ product: string; amountCents: number; intervalCount: number }>> {
  const items: Array<{ product: string; amountCents: number; intervalCount: number }> = [];
  const intervalCount = contract.termMonths;
  // A license carries no credits: credits are bought on the Credits plan.
  const usd = Number(contract.licenseUsd);
  if (usd > 0) items.push({ product: await contractProductId('license'), amountCents: Math.round(usd * 100), intervalCount });
  return items;
}

function contractMetadata(contract: ContractRow): Record<string, string> {
  return { account_id: contract.accountId, plan_key: 'enterprise', contract_id: contract.id };
}

/** An owner's email for the Stripe customer, when the account has no customer yet. */
async function billingEmailFor(accountId: string): Promise<string> {
  const owners = [...(await accountRoleMap(accountId))].filter(([, role]) => role === 'owner').map(([id]) => id);
  const emails = await lookupEmailsByUserIds(owners);
  const email = [...emails.values()].find((value): value is string => !!value);
  if (!email) throw new ContractError('the account has no owner email to bill', 409);
  return email;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

function invalidateCaches(accountId: string): void {
  invalidateCachedAccountTier(accountId);
  clearAccountLimitCache();
}

/**
 * Create a contract.
 *   - `manual`: active at once, the pool granted now.
 *   - `invoice`: Stripe subscription with `collection_method: send_invoice`;
 *     active at once, the pool granted when the invoice is paid.
 *   - `checkout`: an offer. The account's billing managers accept it in the app
 *     (`createOfferCheckout`), or an operator sends them a link.
 */
export async function createContract(input: CreateContractInput): Promise<ContractRow> {
  const invalid = validateContractInput(input);
  if (invalid) throw new ContractError(invalid);
  if (await getOpenOffer(input.accountId)) {
    throw new ContractError('the account already has an open offer; withdraw it first', 409);
  }
  if (input.collection !== 'checkout' && (await getActiveContract(input.accountId))) {
    throw new ContractError('the account already has an active contract; end it first', 409);
  }

  const [offer] = await db
    .insert(enterpriseContracts)
    .values({
      accountId: input.accountId,
      status: 'offered',
      licenseUsd: input.licenseUsd.toFixed(2),
      creditsUsd: '0.00',
      termMonths: input.termMonths ?? 12,
      collection: input.collection,
      note: input.note?.slice(0, 2000) ?? null,
      createdBy: input.actorUserId ?? null,
    })
    .returning();

  if (input.collection === 'checkout') return offer;

  if (input.collection === 'manual') {
    const startsAt = new Date();
    return activateContract(offer.id, {
      startsAt: startsAt.toISOString(),
      endsAt: addMonths(startsAt, offer.termMonths).toISOString(),
      actorUserId: input.actorUserId ?? null,
    });
  }

  // invoice
  try {
    const customer = await getOrCreateStripeCustomer(input.accountId, await billingEmailFor(input.accountId));
    const subscription = await getStripe().subscriptions.create({
      customer,
      collection_method: 'send_invoice',
      days_until_due: INVOICE_DAYS_UNTIL_DUE,
      items: (await contractLineItems(offer)).map((item) => ({
        price_data: {
          currency: 'usd',
          product: item.product,
          unit_amount: item.amountCents,
          recurring: { interval: 'month', interval_count: item.intervalCount },
        },
      })),
      metadata: contractMetadata(offer),
    });
    return activateContract(offer.id, {
      startsAt: new Date(subscription.current_period_start * 1000).toISOString(),
      endsAt: new Date(subscription.current_period_end * 1000).toISOString(),
      stripeSubscriptionId: subscription.id,
      autoRenews: !subscription.cancel_at_period_end,
      actorUserId: input.actorUserId ?? null,
    });
  } catch (err) {
    await db
      .update(enterpriseContracts)
      .set({ status: 'withdrawn', updatedAt: new Date().toISOString(), note: `Stripe failed: ${(err as Error).message}`.slice(0, 2000) })
      .where(eq(enterpriseContracts.id, offer.id));
    throw err;
  }
}

/**
 * A Stripe Checkout session for an open offer. Sessions expire within 24 h, so
 * one is created per click: by a billing manager in the app, or by an operator
 * who sends the link.
 */
export async function createOfferCheckout(params: {
  accountId: string;
  email?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ checkout_url: string; contract_id: string }> {
  const offer = await getOpenOffer(params.accountId);
  if (!offer) throw new ContractError('the account has no open Enterprise offer', 404);
  if (offer.collection !== 'checkout') throw new ContractError('this offer is invoiced, not paid by card', 409);

  const customer = await getOrCreateStripeCustomer(
    params.accountId,
    params.email || (await billingEmailFor(params.accountId)),
  );
  const metadata = contractMetadata(offer);
  const session = await createHostedCheckout(getStripe(), {
    customer,
    mode: 'subscription',
    line_items: (await contractLineItems(offer)).map((item) => ({
      quantity: 1,
      price_data: {
        currency: 'usd',
        product: item.product,
        unit_amount: item.amountCents,
        recurring: { interval: 'month' as const, interval_count: item.intervalCount },
      },
    })),
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    payment_method_collection: 'always',
    subscription_data: { metadata },
    metadata,
  });
  if (!session.url) throw new ContractError('Stripe returned no checkout URL', 409);
  await db
    .update(enterpriseContracts)
    .set({ stripeCheckoutSessionId: session.id, updatedAt: new Date().toISOString() })
    .where(eq(enterpriseContracts.id, offer.id));
  return { checkout_url: session.url, contract_id: offer.id };
}

export async function withdrawOffer(accountId: string, actorUserId: string | null): Promise<ContractRow> {
  const offer = await getOpenOffer(accountId);
  if (!offer) throw new ContractError('the account has no open Enterprise offer', 404);
  const [row] = await db
    .update(enterpriseContracts)
    .set({ status: 'withdrawn', updatedAt: new Date().toISOString() })
    .where(and(eq(enterpriseContracts.id, offer.id), eq(enterpriseContracts.status, 'offered')))
    .returning();
  logger.info(`[enterprise-contracts] offer ${offer.id} on ${accountId} withdrawn by ${actorUserId ?? 'system'}`);
  return row ?? offer;
}

/**
 * Activate a license: the account becomes Licensed (`enterprise_entitled`).
 * Its billing plan and any credits subscription stay as they are. Idempotent:
 * an already-active contract is returned as is.
 */
export async function activateContract(
  contractId: string,
  term: {
    startsAt: string;
    endsAt: string | null;
    stripeSubscriptionId?: string | null;
    autoRenews?: boolean;
    actorUserId?: string | null;
  },
): Promise<ContractRow> {
  const contract = await getContract(contractId);
  if (contract.status === 'active') return contract;
  if (contract.status !== 'offered') throw new ContractError(`contract is ${contract.status}`, 409);
  const existing = await getActiveContract(contract.accountId);
  if (existing) throw new ContractError('the account already has an active contract; end it first', 409);

  const [active] = await db
    .update(enterpriseContracts)
    .set({
      status: 'active',
      startsAt: term.startsAt,
      endsAt: term.endsAt,
      stripeSubscriptionId: term.stripeSubscriptionId ?? contract.stripeSubscriptionId,
      autoRenews: term.autoRenews ?? false,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(enterpriseContracts.id, contractId), eq(enterpriseContracts.status, 'offered')))
    .returning();
  if (!active) return getContract(contractId);

  // Licensed: the Enterprise features. The billing plan is not touched.
  await applyAdminOverride(
    contract.accountId,
    { enterpriseEntitled: true },
    { userId: term.actorUserId ?? null, action: 'enterprise.contract.activate' },
  );
  invalidateCaches(contract.accountId);
  logger.info(`[enterprise-contracts] contract ${contractId} active on ${contract.accountId} (${active.collection})`);
  return active;
}

/**
 * End an active license. The Enterprise features end (the billing plan is not
 * touched), and SSO and SCIM stay on for ACCESS_GRACE_DAYS so nobody is locked
 * out of sign-in.
 */
export async function endContract(
  contractId: string,
  reason: ContractEndReason,
  actorUserId: string | null = null,
): Promise<ContractRow> {
  const contract = await getContract(contractId);
  if (contract.status !== 'active') throw new ContractError(`contract is ${contract.status}`, 409);
  const now = new Date();
  const [ended] = await db
    .update(enterpriseContracts)
    .set({ status: 'ended', endedAt: now.toISOString(), autoRenews: false, updatedAt: now.toISOString() })
    .where(and(eq(enterpriseContracts.id, contractId), eq(enterpriseContracts.status, 'active')))
    .returning();
  if (!ended) return getContract(contractId);

  // Stripe only when there is a subscription to touch: a manual contract on an
  // account without one ends with no Stripe call (and no Stripe configured).
  if (reason === 'operator' && contract.stripeSubscriptionId) {
    await getStripe().subscriptions.cancel(contract.stripeSubscriptionId).catch((err) =>
      logger.warn(`[enterprise-contracts] could not cancel ${contract.stripeSubscriptionId}`, { error: (err as Error).message }),
    );
  }

  const account = await getCreditAccount(contract.accountId);
  const graceEnds = new Date(now.getTime() + ACCESS_GRACE_DAYS * DAY_MS).toISOString();
  const overrides = mergeOverridePatch(account?.entitlementOverrides, {
    sso: { value: true, expires_at: graceEnds },
    scim: { value: true, expires_at: graceEnds },
  });

  await applyAdminOverride(
    contract.accountId,
    { enterpriseEntitled: false, entitlementOverrides: toStoredOverrides(overrides) },
    { userId: actorUserId, action: `enterprise.contract.end.${reason}` },
  );
  invalidateCaches(contract.accountId);
  const { notifyContractEnded } = await import('./access-notices');
  await notifyContractEnded(contract.accountId, graceEnds).catch((err) =>
    logger.warn('[enterprise-contracts] contract-ended notice failed', { error: (err as Error).message }),
  );
  return ended;
}

/** Manual contracts whose term is over end on the access sweep. Returns how many ended. */
export async function endExpiredManualContracts(now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: enterpriseContracts.id })
    .from(enterpriseContracts)
    .where(
      and(
        eq(enterpriseContracts.status, 'active'),
        eq(enterpriseContracts.collection, 'manual'),
        isNotNull(enterpriseContracts.endsAt),
        lte(enterpriseContracts.endsAt, now.toISOString()),
      ),
    );
  let ended = 0;
  for (const { id } of due) {
    await endContract(id, 'term_over');
    ended++;
  }
  return ended;
}

// ─── Stripe webhooks ────────────────────────────────────────────────────────

function contractIdOf(metadata: Stripe.Metadata | null | undefined): string | null {
  return metadata?.contract_id || null;
}

/** Activate the contract behind `subscription` when Stripe says it is live. */
async function ensureActiveFromSubscription(contractId: string, subscription: Stripe.Subscription): Promise<ContractRow> {
  const contract = await getContract(contractId);
  if (contract.status !== 'offered') return contract;
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return contract;
  return activateContract(contractId, {
    startsAt: new Date(subscription.current_period_start * 1000).toISOString(),
    endsAt: new Date(subscription.current_period_end * 1000).toISOString(),
    stripeSubscriptionId: subscription.id,
    autoRenews: !subscription.cancel_at_period_end,
  });
}

/**
 * Route a Stripe event that belongs to a contract. Returns true when the event
 * was a contract event (handled here, never by the credits handlers, which
 * would refuse to write Enterprise).
 */
export async function routeContractEvent(event: Stripe.Event): Promise<boolean> {
  const stripe = getStripe();
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      const contractId = contractIdOf(session.metadata);
      if (!contractId) return false;
      const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (subscriptionId && session.payment_status === 'paid') {
        await ensureActiveFromSubscription(contractId, await stripe.subscriptions.retrieve(subscriptionId));
      }
      return true;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const contractId = contractIdOf(subscription.metadata);
      if (!contractId) return false;
      const contract = await ensureActiveFromSubscription(contractId, subscription);
      if (contract.status === 'active') {
        await db
          .update(enterpriseContracts)
          .set({ autoRenews: !subscription.cancel_at_period_end, updatedAt: new Date().toISOString() })
          .where(eq(enterpriseContracts.id, contract.id));
      }
      return true;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const contractId = contractIdOf(subscription.metadata);
      if (!contractId) return false;
      const contract = await getContract(contractId);
      if (contract.status === 'active') await endContract(contract.id, 'stripe_subscription_deleted');
      return true;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
      if (!subscriptionId) return false;
      // Stripe copies the subscription's metadata onto each of its invoices, so
      // a contract invoice carries contract_id without a database lookup on
      // every invoice event.
      const contractId = contractIdOf(invoice.subscription_details?.metadata);
      if (!contractId) return false;
      if (event.type === 'invoice.payment_failed') {
        logger.warn(`[enterprise-contracts] invoice ${invoice.id} for contract ${contractId} failed to pay`);
        return true;
      }
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const contract = await ensureActiveFromSubscription(contractId, subscription);
      if (contract.status !== 'active') return true;
      const termStart = new Date(subscription.current_period_start * 1000).toISOString();
      const termEnd = new Date(subscription.current_period_end * 1000).toISOString();
      await db
        .update(enterpriseContracts)
        .set({ startsAt: contract.startsAt ?? termStart, endsAt: termEnd, autoRenews: !subscription.cancel_at_period_end, updatedAt: new Date().toISOString() })
        .where(eq(enterpriseContracts.id, contract.id));
      return true;
    }
    default:
      return false;
  }
}
