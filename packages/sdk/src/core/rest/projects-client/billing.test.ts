import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import type {
  AccountState,
  AccountStateAppAccessView,
  UsageBreakdownItem,
  UsageQueryOptions,
} from './billing';
import {
  cancelScheduledChange,
  cancelSubscription,
  confirmCheckoutSession,
  configureAutoTopup,
  claimPerSeatBilling,
  createPerSeatCheckout,
  createCheckoutSession,
  createPortalSession,
  fetchAccountStateWithToken,
  getAccountState,
  getAutoTopupSettings,
  getAutoTopupSetupStatus,
  getDefaultAccountState,
  getProrationPreview,
  purchaseCredits,
  reactivateSubscription,
  resolvedPlan,
  scheduleDowngrade,
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

test('createCheckoutSession posts tier + urls to create-checkout-session', async () => {
  nextResponse = { status: 200, body: { url: 'https://checkout.stripe.com/x' } };
  await createCheckoutSession({
    tierKey: 'pro',
    successUrl: 'https://app.example.com/success',
    cancelUrl: 'https://app.example.com/cancel',
  });
  expect(last().url).toContain('/billing/create-checkout-session');
  expect(last().method).toBe('POST');
  expect(last().body).toMatchObject({ tier_key: 'pro', success_url: 'https://app.example.com/success' });
});

test('confirmCheckoutSession posts session_id to confirm-checkout-session', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await confirmCheckoutSession('cs_123', 'acc-1');
  expect(last().url).toContain('/billing/confirm-checkout-session');
  expect(last().body).toEqual({ account_id: 'acc-1', session_id: 'cs_123' });
});

test('createPortalSession posts return_url to create-portal-session', async () => {
  nextResponse = { status: 200, body: { url: 'https://billing.stripe.com/p/x' } };
  await createPortalSession('https://app.example.com/billing');
  expect(last().url).toContain('/billing/create-portal-session');
  expect(last().body).toEqual({ account_id: undefined, return_url: 'https://app.example.com/billing' });
});

test('cancelSubscription / reactivateSubscription / scheduleDowngrade / cancelScheduledChange hit their endpoints', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await cancelSubscription('too expensive');
  expect(last().url).toContain('/billing/cancel-subscription');

  await reactivateSubscription();
  expect(last().url).toContain('/billing/reactivate-subscription');

  await scheduleDowngrade('starter', 'monthly');
  expect(last().url).toContain('/billing/schedule-downgrade');
  expect(last().body).toMatchObject({ target_tier_key: 'starter', commitment_type: 'monthly' });

  await cancelScheduledChange();
  expect(last().url).toContain('/billing/cancel-scheduled-change');
});

test('per-seat, sync, and auto-topup setup methods own their REST paths', async () => {
  nextResponse = { status: 200, body: { status: 'checkout_created' } };
  await createPerSeatCheckout({
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel',
    accountId: 'acc-1',
  });
  expect(last().url).toContain('/billing/create-per-seat-checkout');
  expect(last().body).toMatchObject({ account_id: 'acc-1' });

  nextResponse = { status: 200, body: { ok: true, status: 'migrated' } };
  await claimPerSeatBilling('acc-1');
  expect(last().url).toContain('/billing/claim-per-seat');

  await syncSubscription('acc-1');
  expect(last().url).toContain('/billing/sync-subscription');

  nextResponse = {
    status: 200,
    body: { has_payment_method: true, has_default_payment_method: true },
  };
  await getAutoTopupSetupStatus('acc-1');
  expect(last().url).toContain('/billing/auto-topup/setup-status?account_id=acc-1');
});

test('getProrationPreview GETs with new_price_id (+ optional account_id) as query params', async () => {
  nextResponse = { status: 200, body: {} };
  await getProrationPreview('price_123', 'acc-1');
  expect(last().url).toContain('/billing/proration-preview?');
  expect(last().url).toContain('new_price_id=price_123');
  expect(last().url).toContain('account_id=acc-1');
  expect(last().method).toBe('GET');
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
// as (trial overlay + per-seat self-heal + grandfathered naming). These pin
// that the selector reads it, and that it still answers on a response from an
// API old enough not to send the block at all.

test('resolvedPlan reads the API plan block verbatim', () => {
  const state: AccountState = {
    ...getDefaultAccountState(),
    plan: {
      key: 'per_seat',
      family: 'team',
      label: 'Team',
      sublabel: '$40/seat/mo · grandfathered',
      status: 'grandfathered',
      shape: 'seat',
      rank: 4,
      is_grandfathered: true,
    },
  };

  expect(resolvedPlan(state)).toEqual({
    family: 'team',
    label: 'Team',
    sublabel: '$40/seat/mo · grandfathered',
    isGrandfathered: true,
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
      key: 'team',
      family: 'team',
      label: 'Team',
      sublabel: null,
      status: 'retired',
      shape: 'flat',
      rank: 8,
      is_grandfathered: false,
    },
  };

  expect(resolvedPlan(state).family).toBe('team');
  expect(resolvedPlan(state).label).toBe('Team');
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
    family: 'team',
    label: 'Ultra (Legacy)',
    sublabel: null,
    isGrandfathered: false,
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
  expect(familyOf('per_seat')).toBe('team');
  expect(familyOf('tier_150_1200')).toBe('team');
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
    isGrandfathered: false,
  });
});

test('the app-access projection carries the resolved plan key', () => {
  // `fetchAccountStateWithToken` returns the raw account-state body, so the
  // login gate can read the plan an account BEHAVES as. Typing the projection
  // without it made the gate branch on the STORED tier, which is `free` for an
  // account on an admin trial.
  const trialing: AccountStateAppAccessView = {
    subscription: { tier_key: 'free' },
    plan: { key: 'team' },
    credits: { can_run: false },
  };
  const olderApi: AccountStateAppAccessView = { subscription: { tier_key: 'free' } };

  expect(trialing.plan?.key).toBe('team');
  expect(olderApi.plan).toBeUndefined();
});
