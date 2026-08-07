import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import {
  replayAuditWebhookDelivery,
  startAuditWebhookWorker,
  stopAuditWebhookWorker,
} from './audit-webhooks';

const databaseUrl = process.env.AUDIT_V2_DATABASE_URL;
const ACCOUNT = 'c7100000-0000-4000-a000-000000000001';
const WEBHOOK = 'c7200000-0000-4000-a000-000000000001';

let client: pg.Client | null = null;
let deliveryId = '';

function databaseClient(): pg.Client {
  if (!client) throw new Error('database client is not initialized');
  return client;
}

async function waitForStatus(status: string, timeoutMs = 5_000, id = deliveryId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await databaseClient().query<{
      status: string;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT status, attempts, last_error
       FROM kortix.audit_webhook_deliveries
       WHERE delivery_id = $1`,
      [id],
    );
    if (result.rows[0]?.status === status) return result.rows[0];
    await Bun.sleep(25);
  }
  throw new Error(`delivery ${id} did not reach ${status}`);
}

describe.skipIf(!databaseUrl)('durable audit webhook worker — migrated PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(
      `INSERT INTO kortix.accounts(account_id, name) VALUES ($1, 'audit-webhook-worker')`,
      [ACCOUNT],
    );
    await client.query(
      `INSERT INTO kortix.credit_accounts(account_id, demo_enterprise)
       VALUES ($1, true)`,
      [ACCOUNT],
    );
    await client.query(
      `INSERT INTO kortix.audit_webhooks(webhook_id, account_id, url, secret, name)
       VALUES ($1, $2, 'http://127.0.0.1:1/audit', 'test-secret', 'failure injection')`,
      [WEBHOOK, ACCOUNT],
    );
    const event = await client.query<{ event_id: string }>(
      `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
       VALUES ($1, 'webhook.failure-injection', 'test', 'system')
       RETURNING event_id`,
      [ACCOUNT],
    );
    const delivery = await client.query<{ delivery_id: string }>(
      `SELECT delivery_id
       FROM kortix.audit_webhook_deliveries
       WHERE webhook_id = $1 AND event_id = $2`,
      [WEBHOOK, event.rows[0]?.event_id],
    );
    const insertedDeliveryId = delivery.rows[0]?.delivery_id;
    if (!insertedDeliveryId) throw new Error('audit delivery was not created');
    deliveryId = insertedDeliveryId;
  });

  afterAll(async () => {
    await stopAuditWebhookWorker();
    if (!client) return;
    await client.query(`SET kortix.audit_maintenance = 'on'`);
    await client.query('DELETE FROM kortix.audit_webhook_deliveries WHERE webhook_id = $1', [
      WEBHOOK,
    ]);
    await client.query('DELETE FROM kortix.audit_events WHERE account_id = $1', [ACCOUNT]);
    await client.query('DELETE FROM kortix.audit_webhooks WHERE webhook_id = $1', [WEBHOOK]);
    await client.query('DELETE FROM kortix.credit_accounts WHERE account_id = $1', [ACCOUNT]);
    await client.query('DELETE FROM kortix.accounts WHERE account_id = $1', [ACCOUNT]);
    await client.end();
  });

  test('retries, replays, reclaims an expired lease, and dead-letters failure', async () => {
    startAuditWebhookWorker();
    const retry = await waitForStatus('retry');
    expect(retry.attempts).toBe(1);
    expect(retry.last_error).toBeTruthy();
    await stopAuditWebhookWorker();

    expect(await replayAuditWebhookDelivery(deliveryId, WEBHOOK)).toBe(true);
    const replayed = await waitForStatus('pending');
    expect(replayed.attempts).toBe(0);
    expect(replayed.last_error).toBeNull();

    await databaseClient().query(
      `UPDATE kortix.audit_webhook_deliveries
       SET status = 'delivering', attempts = 7,
           locked_by = 'crashed-worker', locked_until = now() - interval '1 second'
       WHERE delivery_id = $1`,
      [deliveryId],
    );
    startAuditWebhookWorker();
    const dead = await waitForStatus('dead_letter');
    expect(dead.attempts).toBe(8);
    expect(dead.last_error).toBeTruthy();
    await stopAuditWebhookWorker();

    expect(await replayAuditWebhookDelivery(deliveryId, WEBHOOK)).toBe(true);
    const finalReplay = await waitForStatus('pending');
    expect(finalReplay.attempts).toBe(0);
  });

  test('an expired worker cannot overwrite a delivery claimed by another worker', async () => {
    let releaseResponse: () => void = () => {};
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => {
        await responseGate;
        return new Response(null, { status: 204 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    try {
      const webhook = await databaseClient().query<{ webhook_id: string }>(
        `INSERT INTO kortix.audit_webhooks(account_id, url, secret, name)
         VALUES ($1, $2, 'test-secret', 'lease fencing')
         RETURNING webhook_id`,
        [ACCOUNT, 'https://8.8.8.8/audit'],
      );
      const webhookId = webhook.rows[0]?.webhook_id;
      if (!webhookId) throw new Error('lease-fencing webhook was not created');
      const event = await databaseClient().query<{ event_id: string }>(
        `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source)
         VALUES ($1, 'webhook.lease-fencing', 'test', 'system')
         RETURNING event_id`,
        [ACCOUNT],
      );
      const delivery = await databaseClient().query<{ delivery_id: string }>(
        `SELECT delivery_id
           FROM kortix.audit_webhook_deliveries
          WHERE webhook_id = $1 AND event_id = $2`,
        [webhookId, event.rows[0]?.event_id],
      );
      const fencedDeliveryId = delivery.rows[0]?.delivery_id;
      if (!fencedDeliveryId) throw new Error('lease-fencing delivery was not created');

      startAuditWebhookWorker();
      await waitForStatus('delivering', 5_000, fencedDeliveryId);
      await databaseClient().query(
        `UPDATE kortix.audit_webhook_deliveries
            SET locked_by = 'replacement-worker', locked_until = now() + interval '5 minutes'
          WHERE delivery_id = $1`,
        [fencedDeliveryId],
      );
      releaseResponse();
      await Bun.sleep(100);

      const fenced = await databaseClient().query<{
        status: string;
        locked_by: string | null;
      }>(
        `SELECT status, locked_by
           FROM kortix.audit_webhook_deliveries
          WHERE delivery_id = $1`,
        [fencedDeliveryId],
      );
      expect(fenced.rows[0]).toEqual({
        status: 'delivering',
        locked_by: 'replacement-worker',
      });
    } finally {
      releaseResponse();
      await stopAuditWebhookWorker();
      globalThis.fetch = originalFetch;
    }
  });
});
