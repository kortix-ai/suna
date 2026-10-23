import { afterAll, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { createCliDeviceRouter } from '../cli/device-routes';

const app = new Hono();
app.route('/device', createCliDeviceRouter());
const codes: string[] = [];
const request = (path: string, body: unknown) => app.request(`/device/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': crypto.randomUUID() },
  body: JSON.stringify(body),
});
async function start() {
  const response = await request('start', {});
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const grant = await response.json() as { device_code: string; user_code: string };
  codes.push(grant.user_code);
  expect(grant.device_code).toHaveLength(64);
  expect(grant.user_code).not.toBe(grant.device_code);
  return grant;
}

afterAll(async () => {
  for (const code of codes) await db.execute(sql`delete from kortix.cli_device_grants where user_code=${code}`);
});

test('public grant stores only the secret hash and enforces durable poll pacing', async () => {
  const grant = await start();
  const rows = await db.execute(sql`select device_code_hash from kortix.cli_device_grants where user_code=${grant.user_code}`);
  expect(rows[0]?.device_code_hash).not.toBe(grant.device_code);
  const poll = async () => (await request('poll', { device_code: grant.device_code })).json();
  expect(await poll()).toEqual({ error: 'authorization_pending' });
  expect(await poll()).toEqual({ error: 'slow_down' });
});

test('denied, expired and consumed grants cannot issue a credential', async () => {
  for (const [status, error] of [['denied', 'access_denied'], ['consumed', 'invalid_grant']] as const) {
    const grant = await start();
    await db.execute(sql`update kortix.cli_device_grants set status=${status} where user_code=${grant.user_code}`);
    const response = await request('poll', { device_code: grant.device_code });
    expect(await response.json()).toEqual({ error });
  }
  const grant = await start();
  await db.execute(sql`update kortix.cli_device_grants set expires_at=now()-interval '1 second' where user_code=${grant.user_code}`);
  expect(await (await request('poll', { device_code: grant.device_code })).json()).toEqual({ error: 'expired_token' });
});

test('approval requires authentication and rejects malformed polling secrets', async () => {
  const grant = await start();
  expect((await request('decide', { user_code: grant.user_code, approve: true })).status).toBe(401);
  expect((await request('poll', { device_code: grant.user_code })).status).toBe(400);
});
