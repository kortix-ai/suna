import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import {
  cancelScheduledChange,
  cancelSubscription,
  confirmCheckoutSession,
  configureAutoTopup,
  createCheckoutSession,
  createPortalSession,
  fetchAccountStateWithToken,
  getAccountState,
  getAutoTopupSettings,
  getDefaultAccountState,
  getProrationPreview,
  purchaseCredits,
  reactivateSubscription,
  scheduleDowngrade,
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
