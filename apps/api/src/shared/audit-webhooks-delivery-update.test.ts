import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { auditWebhookDeliveries } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Characterizes the delivery-row UPDATE of every processDelivery outcome: the
// exact fields written and the deliveryId + claiming-worker fence. The real
// module runs against a recording fake `db`.
type Update = { table: unknown; set: Record<string, unknown>; where: SQL };
const updates: Update[] = [];
let selected: unknown[] = [];
let claimed: Array<{ deliveryId: string }> = [];
let entitlement: () => Promise<boolean> = async () => true;
let fetchResult: () => Promise<Response> = async () => new Response('ok', { status: 200 });

const selectChain: Record<string, unknown> = {
  from: () => selectChain,
  innerJoin: () => selectChain,
  where: () => selectChain,
  limit: async () => selected,
};
mock.module('./db', () => ({
  db: {
    execute: async () => claimed,
    select: () => selectChain,
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async (where: SQL) => {
          updates.push({ table, set, where });
          return [];
        },
      }),
    }),
  },
}));
mock.module('../billing/services/entitlements', () => ({ accountHasEntitlement: () => entitlement() }));
mock.module('../marketplace/catalog', () => ({ assertAllowedSourceAddress: () => {} }));
mock.module('./ssrf-guard', () => ({ safeEgressFetch: () => fetchResult() }));
mock.module('./audit-query', () => ({ serializeAuditEvent: () => ({ event_id: 'e1' }) }));

const { runAuditWebhookDeliveryPass } = await import('./audit-webhooks');

const DELIVERY = 'd1000000-0000-4000-8000-000000000001';

function row(over: { attempts?: number; enabled?: boolean } = {}) {
  return {
    delivery: { attempts: over.attempts ?? 0 },
    hook: { webhookId: 'w1', url: 'https://example.test/hook', secret: 's', enabled: over.enabled ?? true },
    event: { eventId: 'e1', accountId: 'acct' },
  };
}

function deliveryUpdates(): Update[] {
  return updates.filter((u) => u.table === auditWebhookDeliveries);
}

function fence(update: Update): { sql: string; params: unknown[] } {
  const q = new PgDialect().sqlToQuery(update.where);
  return { sql: q.sql, params: q.params };
}

function expectFenced(update: Update): void {
  const { sql, params } = fence(update);
  expect(sql).toContain('"delivery_id" = $1');
  expect(sql).toContain('"locked_by" = $2');
  expect(params[0]).toBe(DELIVERY);
  expect(String(params[1])).toMatch(/^audit-webhook-\d+-[0-9a-f]{8}$/);
}

beforeEach(() => {
  updates.length = 0;
  claimed = [{ deliveryId: DELIVERY }];
  selected = [row()];
  entitlement = async () => true;
  fetchResult = async () => new Response('ok', { status: 200 });
});

describe('processDelivery claimed-delivery UPDATE', () => {
  test('claims one delivery and skips when the row is gone', async () => {
    selected = [];
    expect(await runAuditWebhookDeliveryPass()).toBe(1);
    expect(deliveryUpdates()).toHaveLength(0);
  });

  test('entitlement lookup error: retry fields, fenced, lease released', async () => {
    entitlement = async () => {
      throw new Error('pool timeout');
    };
    selected = [row({ attempts: 2 })];
    await runAuditWebhookDeliveryPass();
    const [u] = deliveryUpdates();
    expect(deliveryUpdates()).toHaveLength(1);
    expect(u!.set).toMatchObject({
      status: 'retry',
      attempts: 3,
      lastError: 'entitlement lookup failed: pool timeout',
      lockedBy: null,
      lockedUntil: null,
    });
    expect(u!.set.nextAttemptAt).toBeInstanceOf(Date);
    expect(u!.set.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(u!.set).sort()).toEqual(
      ['attempts', 'lastError', 'lockedBy', 'lockedUntil', 'nextAttemptAt', 'status', 'updatedAt'],
    );
    expectFenced(u!);
  });

  test('not entitled: dead-letter with exact fields', async () => {
    entitlement = async () => false;
    await runAuditWebhookDeliveryPass();
    const [u] = deliveryUpdates();
    expect(u!.set).toMatchObject({
      status: 'dead_letter',
      lockedBy: null,
      lockedUntil: null,
      lastError: 'audit entitlement unavailable',
    });
    expect(Object.keys(u!.set).sort()).toEqual(['lastError', 'lockedBy', 'lockedUntil', 'status', 'updatedAt']);
    expectFenced(u!);
  });

  test('entitled but disabled: dead-letter "webhook disabled"', async () => {
    selected = [row({ enabled: false })];
    await runAuditWebhookDeliveryPass();
    const [u] = deliveryUpdates();
    expect(u!.set.lastError).toBe('webhook disabled');
    expect(u!.set.status).toBe('dead_letter');
    expectFenced(u!);
  });

  test('success: delivered with exact fields', async () => {
    selected = [row({ attempts: 1 })];
    await runAuditWebhookDeliveryPass();
    const [u] = deliveryUpdates();
    expect(deliveryUpdates()).toHaveLength(1);
    expect(u!.set).toMatchObject({
      status: 'delivered',
      attempts: 2,
      lastStatus: 200,
      lastError: null,
      lockedBy: null,
      lockedUntil: null,
    });
    expect(u!.set.deliveredAt).toBeInstanceOf(Date);
    expect(u!.set.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(u!.set).sort()).toEqual(
      ['attempts', 'deliveredAt', 'lastError', 'lastStatus', 'lockedBy', 'lockedUntil', 'status', 'updatedAt'],
    );
    expectFenced(u!);
  });

  test('receiver failure: retry, then dead-letter at the attempt cap', async () => {
    fetchResult = async () => new Response('nope', { status: 503 });
    selected = [row({ attempts: 0 })];
    await runAuditWebhookDeliveryPass();
    selected = [row({ attempts: 7 })];
    await runAuditWebhookDeliveryPass();
    const [first, second] = deliveryUpdates();
    expect(first!.set).toMatchObject({ status: 'retry', attempts: 1, lastStatus: 503, lockedBy: null, lockedUntil: null });
    expect(String(first!.set.lastError)).toMatch(/^HTTP 503; response_sha256=[0-9a-f]{64}$/);
    expect(first!.set.nextAttemptAt).toBeInstanceOf(Date);
    expect(first!.set.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(first!.set).sort()).toEqual(
      ['attempts', 'lastError', 'lastStatus', 'lockedBy', 'lockedUntil', 'nextAttemptAt', 'status', 'updatedAt'],
    );
    expect(second!.set).toMatchObject({ status: 'dead_letter', attempts: 8 });
    expectFenced(first!);
    expectFenced(second!);
  });
});
