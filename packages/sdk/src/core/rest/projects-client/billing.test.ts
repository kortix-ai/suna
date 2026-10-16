import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import type {
  AccountState,
  AccountStateAppAccessView,
  UsageBreakdownItem,
  UsageQueryOptions,
} from './billing';
import {
  canManageBilling,
  canOfferTopup,
  cancelSubscription,
  configureAutoTopup,
  createPortalSession,
  fetchAccountStateWithToken,
  getAccountState,
  getAccountStateMinimal,
  getAutoTopupSettings,
  getAutoTopupSetupStatus,
  getBillingTierConfigurations,
  getDefaultAccountState,
  setBillingPlan,
  previewBillingPlan,
  type PlanChangePreview,
  acceptEnterpriseOffer,
  contactEnterpriseSales,
  purchaseCredits,
  reactivateSubscription,
  requestTopUp,
  resolvedPlan,
  syncSubscription,
  getUsageRollup,
} from './billing';

let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      headers: (opts.headers as Record<string, string>) ?? {},
      body: typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

type IsNever<T> = [T] extends [never] ? true : false;
type UsageAttributionKey<T> = Extract<
  keyof T,
  `${'end_user' | 'origin'}_${'ref'}` | `${'endUser' | 'origin'}Ref`
>;

test('getAccountState hits /billing/account-state and returns the parsed body', async () => {
  const state = { ...getDefaultAccountState(), subscription: { ...getDefaultAccountState().subscription, tier_key: 'pro' } };
  nextResponse = { status: 200, body: state };
  const result = await getAccountState();
  expect(last().url).toContain('/billing/account-state');
  expect(result.subscription.tier_key).toBe('pro');
});

test('getAccountState forwards skipCache and accountId as query params', async () => {
  nextResponse = { status: 200, body: getDefaultAccountState() };
  await getAccountState({ skipCache: true, accountId: 'acc-1' });
  expect(last().url).toContain('skip_cache=true');
  expect(last().url).toContain('account_id=acc-1');
});

test('getAccountState degrades to the default shape when billing is disabled (404)', async () => {
  nextResponse = { status: 404, body: { message: 'billing is not enabled for this deployment' } };
  const result = await getAccountState();
  expect(result).toEqual(getDefaultAccountState());
});

test('getAccountState throws on a genuine server error (not the graceful-disabled case)', async () => {
  nextResponse = { status: 500, body: { message: 'internal error' } };
  await expect(getAccountState()).rejects.toBeTruthy();
});

test('getAccountStateMinimal hits /billing/account-state/minimal and forwards the same params', async () => {
  nextResponse = { status: 200, body: getDefaultAccountState() };
  const result = await getAccountStateMinimal({ skipCache: true, accountId: 'acc-1' });
  expect(last().url).toContain('/billing/account-state/minimal');
  expect(last().url).toContain('skip_cache=true');
  expect(last().url).toContain('account_id=acc-1');
  expect(result).toEqual(getDefaultAccountState());
});

test('getAccountStateMinimal degrades to the default shape when billing is disabled (404)', async () => {
  nextResponse = { status: 404, body: { message: 'billing is not enabled for this deployment' } };
  const result = await getAccountStateMinimal();
  expect(result).toEqual(getDefaultAccountState());
});

test('fetchAccountStateWithToken sends an explicit bearer token, bypassing the ambient seam', async () => {
  nextResponse = {
    status: 200,
    body: { subscription: { tier_key: 'free' }, tier: { name: 'free' }, credits: { can_run: true } },
  };
  const result = await fetchAccountStateWithToken({
    backendUrl: 'http://backend.local/v1',
    accessToken: 'server-token',
  });
  expect(last().url).toBe('http://backend.local/v1/billing/account-state');
  expect(last().headers.Authorization).toBe('Bearer server-token');
  expect(result?.subscription?.tier_key).toBe('free');
});

test('fetchAccountStateWithToken returns null on a non-2xx response instead of throwing', async () => {
  nextResponse = { status: 401, body: { message: 'unauthorized' } };
  const result = await fetchAccountStateWithToken({
    backendUrl: 'http://backend.local/v1',
    accessToken: 'stale-token',
  });
  expect(result).toBeNull();
});

test('fetchAccountStateWithToken returns null without throwing when no token is given', async () => {
  const result = await fetchAccountStateWithToken({ backendUrl: 'http://backend.local/v1', accessToken: '' });
  expect(result).toBeNull();
  expect(calls.length).toBe(0);
});

// ── checkout / subscription / credits mutations ─────────────────────────────

test('createPortalSession posts return_url to create-portal-session', async () => {
  nextResponse = { status: 200, body: { url: 'https://billing.stripe.com/p/x' } };
  await createPortalSession('https://app.example.com/billing');
  expect(last().url).toContain('/billing/create-portal-session');
  expect(last().body).toEqual({ account_id: undefined, return_url: 'https://app.example.com/billing' });
});

test('cancelSubscription / reactivateSubscription hit their endpoints', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await cancelSubscription('too expensive');
  expect(last().url).toContain('/billing/cancel-subscription');

  await reactivateSubscription();
  expect(last().url).toContain('/billing/reactivate-subscription');
});

test('setBillingPlan posts monthly_usd to /billing/plan and returns the checkout_created result', async () => {
  nextResponse = {
    status: 200,
    body: { status: 'checkout_created', checkout_url: 'https://checkout.stripe.test/c', monthly_usd: 100 },
  };
  const result = await setBillingPlan({
    monthlyUsd: 100,
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel',
    locale: 'de',
    accountId: 'acc-1',
  });
  expect(last().url).toContain('/billing/plan');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    monthly_usd: 100,
    success_url: 'https://example.com/success',
    cancel_url: 'https://example.com/cancel',
    locale: 'de',
    account_id: 'acc-1',
  });
  expect(result).toEqual({
    status: 'checkout_created',
    checkout_url: 'https://checkout.stripe.test/c',
    monthly_usd: 100,
  });
});

test('setBillingPlan returns the updated, unchanged and payment_pending variants unchanged', async () => {
  const input = { monthlyUsd: 500, successUrl: 'https://e.test/s', cancelUrl: 'https://e.test/c' };
  for (const body of [
    { status: 'updated', monthly_usd: 500 },
    { status: 'unchanged', monthly_usd: 500 },
    { status: 'payment_pending', monthly_usd: 500, client_secret: 'pi_secret' },
  ]) {
    nextResponse = { status: 200, body };
    expect(await setBillingPlan(input)).toEqual(body as never);
  }
});

test('setBillingPlan returns what changed: raised (charged, credits added), scheduled (from when), kept', async () => {
  const input = { monthlyUsd: 500, successUrl: 'https://e.test/s', cancelUrl: 'https://e.test/c' };
  for (const body of [
    { status: 'updated', change: 'raised', monthly_usd: 500, charged_usd: 133.33, credits_added: 13_333 },
    { status: 'updated', change: 'scheduled', monthly_usd: 100, effective_at: '2026-11-14T00:00:00.000Z' },
    { status: 'updated', change: 'kept', monthly_usd: 500 },
    { status: 'unchanged', change: 'none', monthly_usd: 500 },
  ]) {
    nextResponse = { status: 200, body };
    const result = await setBillingPlan(input);
    expect(result).toEqual(body as never);
  }
});

test('previewBillingPlan posts monthly_usd to /billing/plan/preview and returns the preview', async () => {
  const preview = {
    change: 'raised',
    monthly_usd: 500,
    current_monthly_usd: 300,
    due_now_usd: 66.67,
    credits_now: 6_667,
    effective_at: null,
  };
  nextResponse = { status: 200, body: preview };
  const result: PlanChangePreview = await previewBillingPlan({ monthlyUsd: 500, accountId: 'acc-1' });
  expect(last().url).toContain('/billing/plan/preview');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ monthly_usd: 500, account_id: 'acc-1' });
  expect(result).toEqual(preview as never);
});

test('setBillingPlan surfaces the 400 for an out-of-range amount', async () => {
  nextResponse = { status: 400, body: { error: 'monthly_usd out of range' } };
  await expect(
    setBillingPlan({ monthlyUsd: 5, successUrl: 'https://e.test/s', cancelUrl: 'https://e.test/c' }),
  ).rejects.toMatchObject({ status: 400 });
});

test('acceptEnterpriseOffer posts to /billing/enterprise-offer/checkout and returns the checkout link', async () => {
  nextResponse = { status: 200, body: { checkout_url: 'https://checkout.stripe.test/e', contract_id: 'ctr-1' } };
  const result = await acceptEnterpriseOffer({
    successUrl: 'https://example.com/ok',
    cancelUrl: 'https://example.com/no',
    accountId: 'acc-1',
  });
  expect(last().url).toContain('/billing/enterprise-offer/checkout');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    success_url: 'https://example.com/ok',
    cancel_url: 'https://example.com/no',
    account_id: 'acc-1',
  });
  expect(result).toEqual({ checkout_url: 'https://checkout.stripe.test/e', contract_id: 'ctr-1' });
});

test('acceptEnterpriseOffer surfaces the 404 when there is no open offer', async () => {
  nextResponse = { status: 404, body: { error: 'the account has no open Enterprise offer' } };
  await expect(
    acceptEnterpriseOffer({ successUrl: 'https://e.test/s', cancelUrl: 'https://e.test/c' }),
  ).rejects.toMatchObject({ status: 404 });
});

test('account state carries the trial, contract, offer and grace the API sends', () => {
  const state = {
    trial: { plan: 'enterprise', started_at: null, ends_at: '2026-11-14T00:00:00.000Z', days_left: 9 },
    contract: null,
    enterprise_offer: { id: 'ctr-1', license_usd: 25000, credits_usd: 15000, term_months: 12, collection: 'checkout' },
    grace: null,
  } satisfies Partial<AccountState>;
  expect(state.trial.days_left).toBe(9);
  expect(state.enterprise_offer.collection).toBe('checkout');
});

test('tier configurations expose the purchasable range', async () => {
  nextResponse = {
    status: 200,
    body: { tiers: [], min_monthly_usd: 50, max_monthly_usd: 10000 },
  };
  const result = await getBillingTierConfigurations();
  expect(last().url).toContain('/billing/tier-configurations');
  const range: [number, number] = [result.min_monthly_usd, result.max_monthly_usd];
  expect(range).toEqual([50, 10000]);
});

test('sync and auto-topup setup methods own their REST paths', async () => {
  await syncSubscription('acc-1');
  expect(last().url).toContain('/billing/sync-subscription');

  nextResponse = {
    status: 200,
    body: { has_payment_method: true, has_default_payment_method: true },
  };
  await getAutoTopupSetupStatus('acc-1');
  expect(last().url).toContain('/billing/auto-topup/setup-status?account_id=acc-1');
});

test('purchaseCredits posts amount + urls to purchase-credits', async () => {
  nextResponse = { status: 200, body: { checkout_url: 'https://checkout.stripe.com/credits' } };
  const result = await purchaseCredits({ amount: 20 });
  expect(last().url).toContain('/billing/purchase-credits');
  expect(last().body).toMatchObject({ amount: 20 });
  expect(result.checkout_url).toContain('stripe.com');
});

test('getAutoTopupSettings GETs and configureAutoTopup POSTs auto-topup', async () => {
  nextResponse = { status: 200, body: { enabled: false, threshold: 0, amount: 0 } };
  await getAutoTopupSettings('acc-1');
  expect(last().url).toContain('/billing/auto-topup/settings?account_id=acc-1');
  expect(last().method).toBe('GET');

  nextResponse = { status: 200, body: { enabled: true, threshold: 5, amount: 20 } };
  const result = await configureAutoTopup({ enabled: true, threshold: 5, amount: 20 });
  expect(last().url).toContain('/billing/auto-topup/configure');
  expect(last().method).toBe('POST');
  expect(result.enabled).toBe(true);
});

test('getUsageRollup GETs /usage with no query when unfiltered', async () => {
  nextResponse = { status: 200, body: { data: { total_cost: 0, count: 0 } } };
  await getUsageRollup();
  expect(last().url).toContain('/usage');
  expect(last().url).not.toContain('?');
  expect(last().method).toBe('GET');
});

test('usage contracts omit usage attribution keys and grouping dimensions', () => {
  type GroupBy = NonNullable<UsageQueryOptions['groupBy']>;
  const breakdown: IsNever<UsageAttributionKey<UsageBreakdownItem>> = true;
  const options: IsNever<UsageAttributionKey<UsageQueryOptions>> = true;
  const groups: IsNever<Extract<GroupBy, `${'end_user' | 'origin'}_${'ref'}`>> = true;

  expect([breakdown, options, groups]).toEqual([true, true, true]);
});

test('getUsageRollup serializes only supported grouping dimensions', async () => {
  nextResponse = { status: 200, body: { data: { total_cost: 0, count: 0 } } };
  await getUsageRollup({ groupBy: 'customer' } as unknown as UsageQueryOptions);
  expect(last().url).toBe('http://test.local/usage');
});

// ── resolvedPlan ────────────────────────────────────────────────────────────
// The API's `plan` block is the one place that knows what an account BEHAVES
// as (trial overlay + legacy-key naming). These pin
// that the selector reads it, and that it still answers on a response from an
// API old enough not to send the block at all.

test('resolvedPlan reads the API plan block verbatim', () => {
  const state: AccountState = {
    ...getDefaultAccountState(),
    plan: {
      key: 'credits',
      family: 'credits',
      label: 'Credits',
      sublabel: null,
      status: 'current',
      shape: 'credits',
      rank: 4,
      monthly_usd: 100,
    },
  };

  expect(resolvedPlan(state)).toEqual({
    family: 'credits',
    label: 'Credits',
    sublabel: null,
    monthlyUsd: 100,
  });
});

test('resolvedPlan reports the TRIAL plan, not the stored subscription tier', () => {
  // An admin trial never writes credit_accounts.tier, so `tier_key` stays
  // 'free' while every gate treats the account as Team. Reading `tier_key`
  // here is exactly the skew the plan block exists to end.
  const state: AccountState = {
    ...getDefaultAccountState(),
    subscription: { ...getDefaultAccountState().subscription, tier_key: 'free' },
    plan: {
      key: 'credits',
      family: 'credits',
      label: 'Credits',
      sublabel: null,
      status: 'current',
      shape: 'credits',
      rank: 8,
      monthly_usd: null,
    },
  };

  expect(resolvedPlan(state).family).toBe('credits');
  expect(resolvedPlan(state).label).toBe('Credits');
  expect(resolvedPlan(state).monthlyUsd).toBeNull();
});

test('resolvedPlan falls back to the tier fields when the API sends no plan block', () => {
  const base = getDefaultAccountState();
  const state: AccountState = {
    ...base,
    subscription: { ...base.subscription, tier_key: 'tier_25_200' },
    tier: { ...base.tier, name: 'tier_25_200', display_name: 'Ultra (Legacy)' },
  };

  expect(state.plan).toBeUndefined();
  expect(resolvedPlan(state)).toEqual({
    family: 'credits',
    label: 'Ultra (Legacy)',
    sublabel: null,
    monthlyUsd: null,
  });
});

test('the fallback maps every tier key onto one of the three families', () => {
  const base = getDefaultAccountState();
  const familyOf = (tierKey: string) =>
    resolvedPlan({
      ...base,
      subscription: { ...base.subscription, tier_key: tierKey },
      tier: { ...base.tier, name: tierKey, display_name: '' },
    }).family;

  expect(familyOf('free')).toBe('free');
  expect(familyOf('none')).toBe('free');
  expect(familyOf('enterprise')).toBe('enterprise');
  expect(familyOf('per_seat')).toBe('credits');
  expect(familyOf('credits')).toBe('credits');
  expect(familyOf('tier_150_1200')).toBe('credits');
});

test('the fallback label degrades to the raw tier key, never to an empty string', () => {
  const base = getDefaultAccountState();
  const state: AccountState = {
    ...base,
    subscription: { ...base.subscription, tier_key: 'tier_6_50' },
    tier: { ...base.tier, name: 'tier_6_50', display_name: '' },
  };

  expect(resolvedPlan(state).label).toBe('tier_6_50');
});

test('resolvedPlan answers for a missing account state instead of throwing', () => {
  expect(resolvedPlan(undefined)).toEqual({
    family: 'free',
    label: 'No Plan',
    sublabel: null,
    monthlyUsd: null,
  });
});

test('the app-access projection carries the resolved plan key', () => {
  // `fetchAccountStateWithToken` returns the raw account-state body, so the
  // login gate can read the plan an account BEHAVES as. Typing the projection
  // without it made the gate branch on the STORED tier, which is `free` for an
  // account on an admin trial.
  const trialing: AccountStateAppAccessView = {
    subscription: { tier_key: 'free' },
    plan: { key: 'credits' },
    credits: { can_run: false },
  };
  const olderApi: AccountStateAppAccessView = { subscription: { tier_key: 'free' } };

  expect(trialing.plan?.key).toBe('credits');
  expect(olderApi.plan).toBeUndefined();
});

// KRTX-1718: a member out of credits asks the owners.
test('requestTopUp POSTs to the account top-up-requests route and returns how many owners were told', async () => {
  nextResponse = { status: 202, body: { notified: 2 } };
  const result = await requestTopUp('acc/1');
  expect(last().url).toBe('http://test.local/accounts/acc%2F1/top-up-requests');
  expect(last().method).toBe('POST');
  expect(result).toEqual({ notified: 2 });
});

test('requestTopUp rejects with the 429 status and code when the member already asked', async () => {
  nextResponse = { status: 429, body: { error: 'You already asked', code: 'already_requested' } };
  await expect(requestTopUp('acc_1')).rejects.toMatchObject({ status: 429 });
});

// ── canManageBilling / canOfferTopup ─────────────────────────────────────────
// KRTX-1720: a member at $0 was offered Buy credits and auto top-up, which the
// API answers 403. Every surface that renders a purchase control asks these
// two, and both say no while the account state is still loading.

/** Only the fields these gates read. */
function purchaseState(canPurchaseCredits: boolean, canManage?: boolean): AccountState {
  return {
    subscription: { can_purchase_credits: canPurchaseCredits },
    ...(canManage === undefined ? {} : { can_manage_billing: canManage }),
  } as unknown as AccountState;
}

test('canManageBilling follows can_manage_billing, and says no while the state is unknown', () => {
  expect(canManageBilling(purchaseState(true, true))).toBe(true);
  expect(canManageBilling(purchaseState(true, false))).toBe(false);
  expect(canManageBilling(undefined)).toBe(false);
  expect(canManageBilling(null)).toBe(false);
});

test('canManageBilling keeps an owner on an API that does not send the field', () => {
  // The field is additive on the wire and its own comment says absent means
  // allowed. Every current API response carries it (billing/routes/account-state.ts).
  expect(canManageBilling(purchaseState(true))).toBe(true);
});

test('canOfferTopup needs the plan entitlement AND the billing permission', () => {
  expect(canOfferTopup(purchaseState(true, true))).toBe(true);
  // Entitled plan, wrong person: the purchase would answer 403.
  expect(canOfferTopup(purchaseState(true, false))).toBe(false);
  // Right person, a plan that cannot buy credits.
  expect(canOfferTopup(purchaseState(false, true))).toBe(false);
  expect(canOfferTopup(purchaseState(true))).toBe(true);
});

test('canOfferTopup offers nothing while the account state loads, or without a subscription block', () => {
  expect(canOfferTopup(undefined)).toBe(false);
  expect(canOfferTopup(null)).toBe(false);
  expect(canOfferTopup({} as AccountState)).toBe(false);
  expect(canOfferTopup(getDefaultAccountState())).toBe(false);
});

// The amount the account PAYS, kept during a trial: the plan picker needs it
// to mark the current tier while `plan.monthly_usd` describes the trial.
test('subscription.monthly_usd: the default state carries it as null, never undefined', () => {
  expect(getDefaultAccountState().subscription.monthly_usd).toBeNull();
});

// "Talk to sales" is one click: no form, the account and the signed-in user
// are known to the API (POST /billing/enterprise/contact).
test('contactEnterpriseSales posts the account and an optional note, and returns whether sales was emailed', async () => {
  nextResponse = { status: 200, body: { sent: true } };
  expect(await contactEnterpriseSales({ accountId: 'acc-1', note: 'SSO for 40 people' })).toEqual({ sent: true });
  expect(last().url).toContain('/billing/enterprise/contact');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ account_id: 'acc-1', note: 'SSO for 40 people' });
});
