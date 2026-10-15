// LLM usage settlement against a real PostgreSQL with internal billing on: the
// `usage_events` row a gateway request writes, and the `credit_ledger` rows the
// real wallet writes for it. A settlement the gateway retries, or two that race,
// must write one usage row and move the wallet once: every wallet key is derived
// from that row or from the request id.
import { beforeEach, describe, expect, test } from 'bun:test';
import { creditAccounts, creditLedger, gatewayRequestLogs, usageEvents } from '@kortix/db';
import type { UsageEvent } from '@kortix/llm-gateway';
import { eq } from 'drizzle-orm';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

// `apps/api/src/config` validates the environment at import time, so billing,
// and the keys a managed deployment must hold, are set before the first API
// import. No value is reachable.
Object.assign(process.env, {
  KORTIX_BILLING_INTERNAL_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_usage_settlement',
  STRIPE_WEBHOOK_SECRET: 'whsec_usage_settlement',
  KORTIX_URL: 'http://127.0.0.1:1',
  DAYTONA_API_KEY: 'usage-settlement-test',
  DAYTONA_SERVER_URL: 'http://127.0.0.1:1',
  DAYTONA_TARGET: 'us',
});

const { db } = await import('../shared/db');
const { seedAccount } = await import('../__tests__/helpers/integration-fixtures');
const { recordUsageEvent } = await import('../shared/usage-events');
const { recordGatewayUsage } = await import('./hooks');

const ACTOR = '00000000-0000-4000-a000-000000009b02';
let accountId: string;

function event(requestId: string, over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    accountId,
    actorUserId: ACTOR,
    provider: 'kortix',
    model: 'kortix/test',
    promptTokens: 1_000,
    completionTokens: 200,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    upstreamCost: 0.05,
    finalCost: 0.05,
    billingMode: 'credits',
    streaming: true,
    requestId,
    ...over,
  };
}

const requestId = (label: string) => `req_${label}_${crypto.randomUUID()}`;

async function usageRows(id: string) {
  return db
    .select({ eventId: usageEvents.eventId, metadata: usageEvents.metadata })
    .from(usageEvents)
    .where(eq(usageEvents.requestId, id));
}

async function ledger() {
  const rows = await db
    .select({
      type: creditLedger.type,
      amount: creditLedger.amount,
      description: creditLedger.description,
      idempotencyKey: creditLedger.idempotencyKey,
      metadata: creditLedger.metadata,
    })
    .from(creditLedger)
    .where(eq(creditLedger.accountId, accountId));
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

withDb('gateway usage settlement is idempotent per request', () => {
  beforeEach(async () => {
    accountId = await seedAccount('usage-settlement');
    await db.insert(creditAccounts).values({
      accountId,
      tier: 'credits',
      balance: '10',
      nonExpiringCredits: '10',
    });
  });

  test('a retried or concurrent settlement writes one usage row and one debit', async () => {
    const id = requestId('retry');
    await Promise.all([recordGatewayUsage(event(id)), recordGatewayUsage(event(id))]);
    await recordGatewayUsage(event(id));
    await recordGatewayUsage(event(id));

    const rows = await usageRows(id);
    expect(rows).toHaveLength(1);
    expect(await ledger()).toEqual([
      expect.objectContaining({
        type: 'usage',
        amount: -0.05,
        idempotencyKey: `llm:${rows[0]!.eventId}`,
        metadata: expect.objectContaining({ ledger_type: 'llm_debit' }),
      }),
    ]);
  });

  test('every caller recording one request gets the same usage row back', async () => {
    const id = requestId('readback');
    const input = {
      accountId,
      actorUserId: ACTOR,
      provider: 'kortix',
      model: 'kortix/test',
      route: '/v1/llm/chat/completions',
      costUsd: 0.01,
      requestId: id,
    };
    const concurrent = await Promise.all([recordUsageEvent(input), recordUsageEvent(input)]);
    const sequential = await recordUsageEvent(input);

    expect(concurrent[0]).toBeString();
    expect(new Set([...concurrent, sequential])).toEqual(new Set([concurrent[0]]));
  });

  test('a settlement above the admission hold debits only the difference, keyed on its usage row', async () => {
    const id = requestId('above_hold');
    await recordGatewayUsage(event(id, { billingHoldUsd: 0.01 }));

    const [row] = await usageRows(id);
    expect(await ledger()).toEqual([
      {
        type: 'usage',
        amount: -0.04,
        description: 'LLM · kortix/kortix/test',
        idempotencyKey: `llm:${row!.eventId}`,
        metadata: expect.objectContaining({
          ledger_type: 'llm_debit',
          usageEventId: row!.eventId,
          upstreamCostUsd: 0.05,
          markup: 1.055,
          actorUserId: ACTOR,
          route: '/v1/llm/chat/completions',
        }),
      },
    ]);
  });

  test('a settlement below the admission hold refunds the difference once, keyed on the request', async () => {
    const id = requestId('refund');
    const refund = event(id, { finalCost: 0.001, upstreamCost: 0.001, billingHoldUsd: 0.01 });
    await recordGatewayUsage(refund);
    await recordGatewayUsage(refund);

    expect(await ledger()).toEqual([
      expect.objectContaining({
        type: 'llm_reservation_refund',
        amount: 0.009,
        idempotencyKey: `llm-hold-refund:${id}`,
      }),
    ]);
    // The refund returns money the customer already owned: it is non-expiring
    // credit, so the next renewal's expiring-credit reset cannot wipe it.
    const [grant] = await db
      .select({ isExpiring: creditLedger.isExpiring, expiresAt: creditLedger.expiresAt })
      .from(creditLedger)
      .where(eq(creditLedger.accountId, accountId));
    expect(grant).toEqual({ isExpiring: false, expiresAt: null });
    const [account] = await db
      .select({ expiring: creditAccounts.expiringCredits, nonExpiring: creditAccounts.nonExpiringCredits })
      .from(creditAccounts)
      .where(eq(creditAccounts.accountId, accountId));
    expect({ expiring: Number(account!.expiring), nonExpiring: Number(account!.nonExpiring) }).toEqual({
      expiring: 0,
      nonExpiring: 10.009,
    });
  });

  // The provider bills the customer's own key. Under the monthly allowance
  // (billing/services/byok-fee.ts) Kortix charges nothing, even for an event
  // that carries a cost.
  test('a BYOK settlement under the allowance writes its usage row and moves no money', async () => {
    const id = requestId('byok');
    await recordGatewayUsage(event(id, { billingMode: 'none' }));

    expect(await usageRows(id)).toHaveLength(1);
    expect(await ledger()).toEqual([]);
  });

  // Past $1,000 of list-price BYOK usage this month, each request pays 5% of
  // its list price, settled after the request; subscriptions stay free.
  test('past the allowance a BYOK request pays the 5% fee, and a ChatGPT subscription does not', async () => {
    await db.insert(gatewayRequestLogs).values({
      requestId: requestId('history'),
      accountId,
      requestedModel: 'anthropic/claude',
      resolvedModel: 'claude',
      provider: 'anthropic',
      status: 200,
      ok: true,
      billingMode: 'none',
      upstreamCost: '1500',
    });

    const id = requestId('byok-fee');
    await recordGatewayUsage(event(id, { billingMode: 'none', provider: 'anthropic', upstreamCost: 2, finalCost: 0 }));
    const codex = requestId('codex');
    await recordGatewayUsage(event(codex, { billingMode: 'none', provider: 'openai-codex', upstreamCost: 2, finalCost: 0 }));

    const debits = await ledger();
    expect(debits.map((row) => [row.type, row.amount, row.description])).toEqual([
      ['usage', -0.1, 'BYOK fee · anthropic/kortix/test'],
    ]);
    const [row] = await db.select({ cost: usageEvents.costUsd }).from(usageEvents).where(eq(usageEvents.requestId, id));
    expect(Number(row!.cost)).toBe(0.1);
    expect(await usageRows(codex)).toHaveLength(1);
  });

  // `byokFee` is an entitlement, on by default: an operator override off
  // waives it for one account.
  test('an account with the byokFee entitlement overridden off pays no BYOK fee', async () => {
    await db
      .update(creditAccounts)
      .set({ entitlementOverrides: { byokFee: { value: false } } })
      .where(eq(creditAccounts.accountId, accountId));
    await db.insert(gatewayRequestLogs).values({
      requestId: requestId('history-waived'),
      accountId,
      requestedModel: 'anthropic/claude',
      resolvedModel: 'claude',
      provider: 'anthropic',
      status: 200,
      ok: true,
      billingMode: 'none',
      upstreamCost: '1500',
    });

    const id = requestId('byok-waived');
    await recordGatewayUsage(event(id, { billingMode: 'none', provider: 'anthropic', upstreamCost: 2, finalCost: 0 }));

    expect(await usageRows(id)).toHaveLength(1);
    expect(await ledger()).toEqual([]);
  });

  test('distinct requests each write their own row', async () => {
    const a = requestId('a');
    const b = requestId('b');
    await recordGatewayUsage(event(a));
    await recordGatewayUsage(event(b));
    expect(await usageRows(a)).toHaveLength(1);
    expect(await usageRows(b)).toHaveLength(1);
    expect(await ledger()).toHaveLength(2);
  });

  test('an estimated settlement is marked on its row', async () => {
    const id = requestId('estimated');
    await recordGatewayUsage(event(id, { usageEstimated: true }));
    const [row] = await usageRows(id);
    expect(row?.metadata).toMatchObject({ requestId: id, usageEstimated: true });
  });
});
