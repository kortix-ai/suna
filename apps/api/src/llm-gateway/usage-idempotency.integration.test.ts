import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, usageEvents } from '@kortix/db';
import type { UsageEvent } from '@kortix/llm-gateway';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { recordGatewayUsage } from './hooks';

// Runs against a real PostgreSQL only: the property under test is the
// `uniq_usage_events_request_id` index and `on conflict do nothing`.
const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;
const accountId = '00000000-0000-4000-a000-000000009b01';

function event(requestId: string, over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    accountId,
    actorUserId: '00000000-0000-4000-a000-000000009b02',
    provider: 'kortix',
    model: 'kortix/test-model',
    promptTokens: 1_000,
    completionTokens: 200,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    upstreamCost: 0.001,
    finalCost: 0.0012,
    billingMode: 'credits',
    streaming: true,
    requestId,
    ...over,
  };
}

async function rowsFor(requestId: string) {
  return db
    .select({ eventId: usageEvents.eventId, metadata: usageEvents.metadata })
    .from(usageEvents)
    .where(eq(usageEvents.requestId, requestId));
}

async function cleanup() {
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
}

withDb('gateway usage settlement is idempotent per request', () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(accounts).values({ accountId, name: 'Usage idempotency test' });
  });
  afterAll(cleanup);

  test('a retried settlement of one request writes one usage row', async () => {
    const requestId = `req_idem_${Date.now().toString(36)}`;
    await recordGatewayUsage(event(requestId));
    await recordGatewayUsage(event(requestId));
    await Promise.all([recordGatewayUsage(event(requestId)), recordGatewayUsage(event(requestId))]);
    expect(await rowsFor(requestId)).toHaveLength(1);
  });

  test('distinct requests each write their own row', async () => {
    const stamp = Date.now().toString(36);
    await recordGatewayUsage(event(`req_a_${stamp}`));
    await recordGatewayUsage(event(`req_b_${stamp}`));
    expect(await rowsFor(`req_a_${stamp}`)).toHaveLength(1);
    expect(await rowsFor(`req_b_${stamp}`)).toHaveLength(1);
  });

  test('an estimated settlement is marked on its row', async () => {
    const requestId = `req_est_${Date.now().toString(36)}`;
    await recordGatewayUsage(event(requestId, { usageEstimated: true }));
    const [row] = await rowsFor(requestId);
    expect(row?.metadata).toMatchObject({ requestId, usageEstimated: true });
  });
});
