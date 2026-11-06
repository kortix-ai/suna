import { notifyContractEnded } from './access-notices';
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
import { db, withDbTransaction } from '../../shared/db';
import { type StatusRule, transitionStatus } from '../../shared/status-transition';
import { getStripe } from '../../shared/stripe';
import { getCreditAccount } from '../repositories/credit-accounts';
import { getCustomerByAccountId } from '../repositories/customers';
import { applyAdminOverride } from './account-write-owner';
import { mergeOverridePatch, toStoredOverrides } from './entitlement-overrides';
import { invalidateCachedAccountTier } from './entitlements';
import { ACCESS_GRACE_DAYS } from './resolve-billing';
import { getOrCreateStripeCustomer } from './subscriptions';

export type ContractRow = typeof enterpriseContracts.$inferSelect;
export type ContractCollection = 'checkout' | 'invoice' | 'manual';
export type ContractEndReason = 'operator' | 'term_over' | 'stripe_subscription_deleted' | 'account_closed';

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

// replica-local: Stripe license product id, cached per process.
let licenseProductId: string | undefined;

/** The Stripe license product, found by metadata or created once. */
async function contractProductId(): Promise<string> {
  if (licenseProductId) return licenseProductId;
  const stripe = getStripe();
  const found = await stripe.products.search({ query: "metadata['kortix_product']:'enterprise_license'", limit: 1 });
  const id =
    found.data[0]?.id ??
    (
      await stripe.products.create({
        name: 'Kortix Enterprise license',
        metadata: { kortix_product: 'enterprise_license' },
      })
    ).id;
  licenseProductId = id;
  return id;
}

/** The license line item of a contract, skipped at $0. */
async function contractLineItems(contract: ContractRow) {
  // A license carries no credits: credits are bought on the Credits plan.
  const usd = Number(contract.licenseUsd);
  return usd > 0 ? [{ product: await contractProductId(), amountCents: Math.round(usd * 100), intervalCount: contract.termMonths }] : [];
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

/** The contract's status moves. Each is one compare-and-set on its `from`. */
export const CONTRACT_TRANSITIONS = {
  activate: { from: ['offered'], to: 'active' },
  end: { from: ['active'], to: 'ended' },
  withdraw: { from: ['offered'], to: 'withdrawn' },
} as const satisfies Record<string, StatusRule>;

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
  // Every collection, checkout included: an offer paid while a contract is
  // active can never activate (one active contract per account), so the
  // customer would pay for a subscription that grants nothing.
  if (await getActiveContract(input.accountId)) {
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
  let createdSubscriptionId: string | null = null;
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
    createdSubscriptionId = subscription.id;
    return activateContract(offer.id, {
      startsAt: new Date(subscription.current_period_start * 1000).toISOString(),
      endsAt: new Date(subscription.current_period_end * 1000).toISOString(),
      stripeSubscriptionId: subscription.id,
      autoRenews: !subscription.cancel_at_period_end,
      actorUserId: input.actorUserId ?? null,
    });
  } catch (err) {
    // A subscription Stripe already created bills until it is cancelled. The
    // offer is withdrawn only once nothing bills for it; when the cancel fails
    // too, the offer stays `offered` and the subscription's own webhooks
    // activate it, so a live subscription never sits behind a withdrawn offer.
    if (createdSubscriptionId) {
      try {
        await getStripe().subscriptions.cancel(createdSubscriptionId);
      } catch (cancelErr) {
        logger.error(`[enterprise-contracts] offer ${offer.id}: activation failed and its subscription ${createdSubscriptionId} could not be cancelled`, {
          error: (cancelErr as Error).message,
        });
        throw err;
      }
    }
    await transitionStatus(enterpriseContracts, enterpriseContracts.status, CONTRACT_TRANSITIONS.withdraw, {
      where: eq(enterpriseContracts.id, offer.id),
      set: { updatedAt: new Date().toISOString(), note: `Stripe failed: ${(err as Error).message}`.slice(0, 2000) },
    });
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
  // The offer's Checkout session stays payable for 24 h. Expire it first: a
  // payment after the withdrawal would leave a live subscription that grants
  // nothing. A session already paid refuses the withdrawal instead.
  if (offer.collection === 'checkout') await expireOfferCheckouts(offer);
  const moved = await transitionStatus(enterpriseContracts, enterpriseContracts.status, CONTRACT_TRANSITIONS.withdraw, {
    where: eq(enterpriseContracts.id, offer.id),
    set: { updatedAt: new Date().toISOString() },
  });
  logger.info(`[enterprise-contracts] offer ${offer.id} on ${accountId} withdrawn by ${actorUserId ?? 'system'}`);
  return moved.applied ? moved.row : getContract(offer.id);
}

/**
 * Expire every open Checkout session of the offer. Each click makes a new
 * session and the row keeps only the last one, so the customer's sessions are
 * listed and matched on the `contract_id` they carry. 409 when one is paid.
 */
async function expireOfferCheckouts(offer: ContractRow): Promise<void> {
  const stripe = getStripe();
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const customer = await getCustomerByAccountId(offer.accountId);
  if (customer?.id) {
    const page = await stripe.checkout.sessions.list({ customer: customer.id, limit: 100 });
    for (const session of page.data) {
      if (session.metadata?.contract_id === offer.id) sessions.set(session.id, session);
    }
  }
  if (offer.stripeCheckoutSessionId && !sessions.has(offer.stripeCheckoutSessionId)) {
    sessions.set(offer.stripeCheckoutSessionId, await stripe.checkout.sessions.retrieve(offer.stripeCheckoutSessionId));
  }
  const paid = () => new ContractError('the offer was already paid; it activates when Stripe confirms the payment', 409);
  if ([...sessions.values()].some((session) => session.status === 'complete')) throw paid();
  for (const session of sessions.values()) {
    if (session.status !== 'open') continue;
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (err) {
      // Expired or paid between the two calls: read it again.
      const again = await stripe.checkout.sessions.retrieve(session.id);
      if (again.status === 'complete') throw paid();
      if (again.status !== 'expired') throw err;
    }
  }
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

  // The status and the entitlement commit together: a crash between them left
  // an active contract with no license, and the retry returned early above.
  const active = await withDbTransaction(async () => {
    const moved = await transitionStatus(enterpriseContracts, enterpriseContracts.status, CONTRACT_TRANSITIONS.activate, {
      where: eq(enterpriseContracts.id, contractId),
      set: {
        startsAt: term.startsAt,
        endsAt: term.endsAt,
        stripeSubscriptionId: term.stripeSubscriptionId ?? contract.stripeSubscriptionId,
        autoRenews: term.autoRenews ?? false,
        updatedAt: new Date().toISOString(),
      },
    });
    if (!moved.applied) return null;
    // Licensed: the Enterprise features. The billing plan is not touched.
    await applyAdminOverride(
      contract.accountId,
      { enterpriseEntitled: true },
      { userId: term.actorUserId ?? null, action: 'enterprise.contract.activate' },
    );
    return moved.row;
  });
  if (!active) return getContract(contractId);

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
  const graceEnds = new Date(now.getTime() + ACCESS_GRACE_DAYS * DAY_MS).toISOString();
  // The status and the entitlement commit together: a crash between them left
  // an ended contract whose `enterprise_entitled` stayed true forever.
  const ended = await withDbTransaction(async () => {
    const moved = await transitionStatus(enterpriseContracts, enterpriseContracts.status, CONTRACT_TRANSITIONS.end, {
      where: eq(enterpriseContracts.id, contractId),
      set: { endedAt: now.toISOString(), autoRenews: false, updatedAt: now.toISOString() },
    });
    if (!moved.applied) return null;
    const account = await getCreditAccount(contract.accountId);
    const overrides = mergeOverridePatch(account?.entitlementOverrides, {
      sso: { value: true, expires_at: graceEnds },
      scim: { value: true, expires_at: graceEnds },
    });
    await applyAdminOverride(
      contract.accountId,
      { enterpriseEntitled: false, entitlementOverrides: toStoredOverrides(overrides) },
      { userId: actorUserId, action: `enterprise.contract.end.${reason}` },
    );
    return moved.row;
  });
  if (!ended) return getContract(contractId);

  // Stripe only when there is a subscription to touch: a manual contract on an
  // account without one ends with no Stripe call (and no Stripe configured).
  if (reason === 'operator' && contract.stripeSubscriptionId) {
    await getStripe().subscriptions.cancel(contract.stripeSubscriptionId).catch((err) =>
      logger.warn(`[enterprise-contracts] could not cancel ${contract.stripeSubscriptionId}`, { error: (err as Error).message }),
    );
  }

  invalidateCaches(contract.accountId);
  // A closed account has nobody left to tell.
  if (reason === 'account_closed') return ended;
  await notifyContractEnded(contract.accountId, graceEnds).catch((err) =>
    logger.warn('[enterprise-contracts] contract-ended notice failed', { error: (err as Error).message }),
  );
  return ended;
}

/**
 * Account closure (account-deletion.ts): end the active contract and withdraw
 * an open offer. The closure cancels every Stripe subscription itself.
 */
export async function endContractForClosedAccount(accountId: string): Promise<void> {
  const active = await getActiveContract(accountId);
  if (active) await endContract(active.id, 'account_closed');
  const offer = await getOpenOffer(accountId);
  if (offer) {
    await transitionStatus(enterpriseContracts, enterpriseContracts.status, CONTRACT_TRANSITIONS.withdraw, {
      where: eq(enterpriseContracts.id, offer.id),
      set: { updatedAt: new Date().toISOString(), note: 'account closed' },
    });
  }
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
  const live = subscription.status === 'active' || subscription.status === 'trialing';
  // A subscription for an offer that was withdrawn (or that lost to another
  // contract) grants nothing, so it must not keep billing. The one charge
  // already taken needs a person: the log says so.
  if ((contract.status === 'withdrawn' || contract.status === 'ended') && live && contract.stripeSubscriptionId !== subscription.id) {
    await getStripe().subscriptions.cancel(subscription.id).catch((err) => {
      if ((err as { code?: string }).code !== 'resource_missing') throw err;
    });
    logger.error(`[enterprise-contracts] cancelled subscription ${subscription.id} of ${contract.status} contract ${contractId}; refund the payment by hand`);
    return contract;
  }
  if (contract.status !== 'offered') return contract;
  if (!live) return contract;
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
