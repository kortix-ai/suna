import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { config } from '../config';
import { processSalesOutbox } from './sales-outbox';

const userId = '00000000-0000-4000-8000-000000000099';
const originalFetch = globalThis.fetch;

describe('transactional Sales outbox on PostgreSQL', () => {
  beforeEach(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
    await db.execute(sql`DELETE FROM kortix.sales_event_outbox`);
    await db.execute(sql`DELETE FROM auth.users WHERE id = ${userId}`);
    config.SIGNUP_WEBHOOK_URL = 'https://sales.example.test/events';
    config.SIGNUP_WEBHOOK_SECRET = 'synthetic-secret';
    globalThis.fetch = originalFetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  async function confirm() {
    await db.execute(sql`INSERT INTO auth.users(id,email,created_at) VALUES (${userId},'agent@kortix.ai','2026-01-01')`);
    expect(await db.execute(sql`SELECT * FROM kortix.sales_event_outbox`)).toHaveLength(0);
    await db.execute(sql`UPDATE auth.users SET email_confirmed_at = '2026-01-02' WHERE id = ${userId}`);
  }

  test('commit survives process restart before dispatch; repeated confirmation deduplicates', async () => {
    await confirm();
    await db.execute(sql`UPDATE auth.users SET email_confirmed_at = '2026-01-02' WHERE id = ${userId}`);
    const rows = await db.execute<{ payload: { data: { created_at: string; email_confirmed_at: string } } }>(sql`SELECT payload FROM kortix.sales_event_outbox`);
    expect(rows).toHaveLength(1);
    expect(Date.parse(rows[0]?.payload.data.created_at)).toBe(Date.parse('2026-01-01'));
    expect(Date.parse(rows[0]?.payload.data.email_confirmed_at)).toBe(Date.parse('2026-01-02'));
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 202 }), { preconnect: originalFetch.preconnect });
    await processSalesOutbox();
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox WHERE delivered_at IS NOT NULL`)).toHaveLength(1);
  });

  test('unset receiver leaves confirmed signup durable without a delivery attempt', async () => {
    await confirm();
    config.SIGNUP_WEBHOOK_URL = '';
    await processSalesOutbox();
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox WHERE attempts=0 AND delivered_at IS NULL AND lease_token IS NULL`)).toHaveLength(1);
    expect(await db.execute(sql`SELECT 1 FROM auth.users WHERE id=${userId} AND email_confirmed_at IS NOT NULL`)).toHaveLength(1);
  });

  test('receiver outage retries durably, crash after receipt redelivers identical event', async () => {
    await confirm();
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 503 }), { preconnect: originalFetch.preconnect });
    await processSalesOutbox();
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox WHERE attempts=1 AND delivered_at IS NULL AND last_error='HTTP 503'`)).toHaveLength(1);
    const bodies: string[] = [];
    globalThis.fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response(null, { status: 202 }); }, { preconnect: originalFetch.preconnect });
    await db.execute(sql`UPDATE kortix.sales_event_outbox SET available_at=now()`);
    await processSalesOutbox();
    await db.execute(sql`UPDATE kortix.sales_event_outbox SET delivered_at=NULL,available_at=now(),lease_token=gen_random_uuid()`);
    await processSalesOutbox();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox WHERE attempts=3 AND delivered_at IS NOT NULL`)).toHaveLength(1);
  });

  test('exhausted deliveries dead-letter and stop retrying', async () => {
    await confirm();
    await db.execute(sql`UPDATE kortix.sales_event_outbox SET attempts=19`);
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 401 }), { preconnect: originalFetch.preconnect });
    await processSalesOutbox();
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox WHERE attempts=20 AND dead_letter_at IS NOT NULL`)).toHaveLength(1);
    await processSalesOutbox();
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox WHERE attempts=20`)).toHaveLength(1);
  });

  test('anonymous and authenticated database writers cannot enqueue signed demo events', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.transaction(async (tx) => {
        if (role === 'anon') await tx.execute(sql`SET LOCAL ROLE anon`);
        else await tx.execute(sql`SET LOCAL ROLE authenticated`);
        await tx.execute(sql`INSERT INTO public.contact_forms(data) VALUES ('{"email":"agent@kortix.ai","form":"demo"}')`);
      });
    }
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox`)).toHaveLength(0);
    await db.execute(sql`INSERT INTO public.contact_forms(data) VALUES ('{"email":"agent@kortix.ai","form":"demo"}')`);
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox`)).toHaveLength(1);
  });

  test('demo persistence enqueues atomically, careers excluded, rollback leaves nothing', async () => {
    await db.execute(sql`INSERT INTO public.contact_forms(data) VALUES ('{"email":"agent@kortix.ai","source":"contact","form":"demo"}'), ('{"email":"agent@kortix.ai","source":"careers-application","opening":"synthetic"}')`);
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox WHERE payload->>'type'='demo.requested'`)).toHaveLength(1);
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO public.contact_forms(data) VALUES ('{"email":"agent@kortix.ai","form":"demo"}')`);
      throw new Error('simulated crash before commit');
    })).rejects.toThrow('simulated crash');
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox`)).toHaveLength(1);
  });
});

import { OpenAPIHono } from '@hono/zod-openapi';
import { registerSalesReconciliation } from './sales-reconciliation';

test('reconciliation authorizes, pages tied timestamps without loss and binds cursor range', async () => {
  config.SALES_RECONCILIATION_TOKEN = 'synthetic-reconciliation-token';
  await db.execute(sql`DELETE FROM auth.users`);
  await db.execute(sql`INSERT INTO auth.users(id,email,created_at,email_confirmed_at)
    SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, 'agent-' || n || '@kortix.ai', '2026-01-01','2026-01-02'
    FROM generate_series(1,101) n`);
  const app = new OpenAPIHono();
  registerSalesReconciliation(app);
  const url = '/v1/system/confirmed-signups?from=2026-01-01&to=2026-02-01';
  expect((await app.request(url)).status).toBe(401);
  const headers = { authorization: 'Bearer synthetic-reconciliation-token' };
  const first = await (await app.request(url, { headers })).json();
  expect(first.events).toHaveLength(100);
  expect(first.events[0].data.email_kind).toBe('work');
  const second = await (await app.request(`${url}&cursor=${first.next_cursor}`, { headers })).json();
  expect(second.events).toHaveLength(1);
  expect(second.next_cursor).toBeNull();
  expect(second.events[0].event_id).not.toBe(first.events[99].event_id);
  expect((await app.request(`${url}&cursor=invalid`, { headers })).status).toBe(400);
  expect((await app.request(`${url.replace('2026-02-01','2026-03-01')}&cursor=${first.next_cursor}`, { headers })).status).toBe(400);
});

test('real HTTP receiver recovers, validates signature, and concurrent workers claim once', async () => {
  const { createHmac } = await import('node:crypto');
  await db.execute(sql`DELETE FROM kortix.sales_event_outbox`);
  await db.execute(sql`INSERT INTO kortix.sales_event_outbox(event_id,payload) VALUES
    ('demo.requested:synthetic-http','{"schema_version":1,"event_id":"demo.requested:synthetic-http","type":"demo.requested","data":{"email":"agent@kortix.ai"}}')`);
  let healthy = false;
  const bodies: string[] = [];
  const signatures: boolean[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.text();
    bodies.push(body);
    signatures.push(request.headers.get('x-kortix-signature') === `sha256=${createHmac('sha256', 'synthetic-secret').update(`${request.headers.get('x-kortix-timestamp')}.${body}`).digest('hex')}`);
    return new Response(null, { status: healthy ? 202 : 503 });
  } });
  config.SIGNUP_WEBHOOK_URL = `http://localhost:${server.port}/sales/ingest`;
  config.SIGNUP_WEBHOOK_SECRET = 'synthetic-secret';
  globalThis.fetch = originalFetch;
  try {
    await processSalesOutbox();
    expect(bodies).toHaveLength(1);
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox WHERE delivered_at IS NULL AND attempts=1`)).toHaveLength(1);
    healthy = true;
    await db.execute(sql`UPDATE kortix.sales_event_outbox SET available_at=now()`);
    await Promise.all([processSalesOutbox(), processSalesOutbox()]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(signatures).toEqual([true, true]);
    expect(await db.execute(sql`SELECT 1 FROM kortix.sales_event_outbox WHERE delivered_at IS NOT NULL AND attempts=2`)).toHaveLength(1);
  } finally { await server.stop(true); }
});

test('reconciliation rejects ambiguous bounds and cursor timestamps before SQL casting', async () => {
  config.SALES_RECONCILIATION_TOKEN = 'synthetic-reconciliation-token';
  const app = new OpenAPIHono();
  registerSalesReconciliation(app);
  const headers = { authorization: 'Bearer synthetic-reconciliation-token' };
  const from = '2026-01-01';
  const to = '2026-02-01';
  for (const invalid of ['0', '1', '01/02/2026', '2026-02-30', 'not-a-date', '2026-01-01T00:00:00+16:00']) {
    for (const key of ['from', 'to']) {
      const query = new URLSearchParams({ from, to, [key]: invalid });
      expect((await app.request(`/v1/system/confirmed-signups?${query}`, { headers })).status).toBe(400);
    }
    const cursor = Buffer.from(JSON.stringify({ from, to, time: invalid, id: userId })).toString('base64url');
    expect((await app.request(`/v1/system/confirmed-signups?${new URLSearchParams({ from, to, cursor })}`, { headers })).status).toBe(400);
  }
  expect((await app.request(`/v1/system/confirmed-signups?${new URLSearchParams({ from, to })}`, { headers })).status).toBe(200);
});


test('reconciliation accepts date-only days 16 and 31 in both bounds', async () => {
  config.SALES_RECONCILIATION_TOKEN = 'synthetic-reconciliation-token';
  const app = new OpenAPIHono();
  registerSalesReconciliation(app);
  const headers = { authorization: 'Bearer synthetic-reconciliation-token' };
  for (const day of ['16', '31']) {
    for (const bounds of [{ from: `2026-01-${day}`, to: '2026-02-01' }, { from: '2026-01-01', to: `2026-01-${day}` }]) {
      expect((await app.request(`/v1/system/confirmed-signups?${new URLSearchParams(bounds)}`, { headers })).status).toBe(200);
    }
  }
});

test('expired or reclaimed lease during enrichment cannot dispatch', async () => {
  config.SIGNUP_WEBHOOK_URL = 'https://sales.example.test/events';
  config.SIGNUP_WEBHOOK_SECRET = 'synthetic-secret';
  for (const reclaimed of [false, true]) {
    await db.execute(sql`DELETE FROM kortix.sales_event_outbox`);
    await db.execute(sql`INSERT INTO kortix.sales_event_outbox(event_id,payload) VALUES ('demo.requested:lease-probe','{"type":"demo.requested"}')`);
    let sends = 0;
    globalThis.fetch = Object.assign(async () => { sends++; return new Response(null, { status: 202 }); }, { preconnect: originalFetch.preconnect });
    try {
      await processSalesOutbox(db, async (payload) => {
        await db.execute(sql`UPDATE kortix.sales_event_outbox SET available_at = now() - interval '1 second'`);
        if (reclaimed) await db.execute(sql`UPDATE kortix.sales_event_outbox SET lease_token = '00000000-0000-4000-8000-000000000088', available_at = now() + interval '5 minutes'`);
        return payload;
      });
      expect(sends).toBe(0);
      const rows = await db.execute<{ delivered_at: string | null }>(sql`SELECT delivered_at FROM kortix.sales_event_outbox`);
      expect(rows[0]?.delivered_at).toBeNull();
    } finally { globalThis.fetch = originalFetch; }
  }
});
