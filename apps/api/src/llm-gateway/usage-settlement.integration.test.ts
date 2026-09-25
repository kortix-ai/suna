// LLM usage settlement against a real PostgreSQL with internal billing on: the
// `usage_events` row a gateway request writes, and the `credit_ledger` rows the
// real wallet writes for it. A settlement the gateway retries, or two that race,
// must write one usage row and move the wallet once: every wallet key is derived
// from that row or from the request id.
import { beforeEach, describe, expect, test } from 'bun:test';
import { creditAccounts, creditLedger, usageEvents } from '@kortix/db';
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
      billingModel: 'per_seat',
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
          markup: 1.2,
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
  });

  // The provider bills the customer's own key; Kortix never charges it, even
  // for an event that carries a cost.
  test('a BYOK settlement writes its usage row and moves no money', async () => {
    const id = requestId('byok');
    await recordGatewayUsage(event(id, { billingMode: 'none' }));

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
