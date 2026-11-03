import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { deliverSalesEvent, salesHeaders, salesRetryDelay } from './sales-delivery';

describe('Sales durable delivery transport', () => {
  test('signs timestamp and exact serialized body, not just body', () => {
    const body = '{"event_id":"demo.requested:synthetic"}';
    const headers = salesHeaders(body, 'synthetic-secret', 1_000_000);
    expect(headers['X-Kortix-Timestamp']).toBe('1000');
    expect(headers['X-Kortix-Signature']).toBe(`sha256=${createHmac('sha256', 'synthetic-secret').update(`1000.${body}`).digest('hex')}`);
  });
  test('receiver down then recovering preserves event identity on every attempt', async () => {
    const bodies: string[] = [];
    const statuses = [503, 202, 202];
    const send = async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(null, { status: statuses[bodies.length - 1] });
    };
    const event = { event_id: 'account.signup:synthetic', type: 'account.signup' };
    expect(await deliverSalesEvent(event, 'https://example.test', 'secret', send)).toBe('HTTP 503');
    expect(await deliverSalesEvent(event, 'https://example.test', 'secret', send)).toBeNull();
    expect(await deliverSalesEvent(event, 'https://example.test', 'secret', send)).toBeNull();
    expect(new Set(bodies).size).toBe(1);
  });
  test('backoff increases and is capped at a day', () => {
    expect(salesRetryDelay(1)).toBe(30_000);
    expect(salesRetryDelay(2)).toBe(60_000);
    expect(salesRetryDelay(20)).toBe(86_400_000);
  });
});

test('signup classification includes freemail, disposable and work', async () => {
  const { enrichSalesEvent } = await import('./sales-event');
  for (const [email, kind] of [['agent@kortix.ai', 'work'], ['agent@gmail.com', 'freemail'], ['agent@mailinator.com', 'disposable']]) {
    expect(enrichSalesEvent({ type: 'account.signup', data: { email } })).toMatchObject({ data: { email_kind: kind } });
  }
});
