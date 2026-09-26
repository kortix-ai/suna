/**
 * The sites that record a caller address (audit rows, IAM request context,
 * session activity) read it through shared/client-ip.ts. With the default
 * KORTIX_TRUSTED_PROXY_HOPS = 2 the recorded address is the entry two places
 * from the right of X-Forwarded-For, never the caller-written leftmost entry.
 *
 * Documentation address ranges only (RFC 5737).
 */
import { describe, expect, test } from 'bun:test';
import { Hono, type Context } from 'hono';
import { buildActor } from '../iam/actor';
import { deriveRequestContext } from '../iam/cache';
import { attachInboundAuditScope } from '../shared/audit-scope';
import { requestClientIp } from '../shared/client-ip';
import { requestAuditContext } from '../projects/lib/serializers';

const CALLER_WRITTEN = '192.0.2.1';
const CLIENT = '203.0.113.9';
const EDGE = '198.51.100.7';
const CHAIN = `${CALLER_WRITTEN}, ${CLIENT}, ${EDGE}`;

async function withContext<T>(
  headers: Record<string, string>,
  read: (c: Context) => T | Promise<T>,
): Promise<T> {
  let out: T | undefined;
  const app = new Hono();
  app.get('/', async (c) => {
    out = await read(c);
    return c.body(null, 204);
  });
  await app.request('/', { headers });
  return out as T;
}

describe('audit and IAM sites record the hop-selected client address', () => {
  test('requestClientIp selects the entry at the configured hop', async () => {
    expect(await withContext({ 'x-forwarded-for': CHAIN }, requestClientIp)).toBe(CLIENT);
  });

  test('requestClientIp is null when neither header is set', async () => {
    expect(await withContext({}, requestClientIp)).toBeNull();
  });

  test('project audit context', async () => {
    const ctx = await withContext({ 'x-forwarded-for': CHAIN }, requestAuditContext);
    expect(ctx.ip).toBe(CLIENT);
    expect((await withContext({}, requestAuditContext)).ip).toBeNull();
  });

  test('IAM request context', async () => {
    expect((await withContext({ 'x-forwarded-for': CHAIN }, deriveRequestContext)).ip).toBe(CLIENT);
    expect((await withContext({}, deriveRequestContext)).ip).toBeUndefined();
  });

  test('IAM actor context', async () => {
    const actor = await withContext({ 'x-forwarded-for': CHAIN }, (c) => {
      c.set('userId', 'a7100000-0000-4000-a000-000000000001');
      return buildActor(c, 'a7100000-0000-4000-a000-000000000002');
    });
    expect(actor?.ctx.ip).toBe(CLIENT);
  });

  test('inbound audit scope', () => {
    const scope = (headers: Record<string, string>) =>
      attachInboundAuditScope({ owner: 'hono', method: 'GET', headers: new Headers(headers) });
    expect(scope({ 'x-forwarded-for': CHAIN }).ip).toBe(CLIENT);
    expect(scope({ 'x-real-ip': CLIENT }).ip).toBe(CLIENT);
    expect(scope({}).ip).toBeNull();
  });
});
