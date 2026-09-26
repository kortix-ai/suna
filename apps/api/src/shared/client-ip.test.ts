import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { clientIpFromHeaders, clientKeyFromHeaders, requestClientIp, requestClientKey } from './client-ip';

function headers(values: Record<string, string>) {
  return (name: string) => values[name.toLowerCase()] ?? null;
}

describe('clientIpFromHeaders — trusted-proxy rule', () => {
  test('ignores entries the caller wrote to the left of the proxy-appended ones', () => {
    // Cloudflare appends the caller, the ALB appends the Cloudflare edge.
    const read = headers({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9, 203.0.113.7, 172.70.1.2' });
    expect(clientIpFromHeaders(read, 2)).toBe('203.0.113.7');
  });

  test('a forged leftmost entry never changes the result', () => {
    for (const forged of ['1.2.3.4', '5.6.7.8', 'not-an-ip']) {
      const read = headers({ 'x-forwarded-for': `${forged}, 203.0.113.7, 172.70.1.2` });
      expect(clientIpFromHeaders(read, 2)).toBe('203.0.113.7');
    }
  });

  test('a chain shorter than the hop count holds only proxy-written entries', () => {
    // Self-host Caddy replaces an untrusted header with one entry.
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '198.51.100.4' }), 2)).toBe(
      '198.51.100.4',
    );
  });

  test('one hop reads the rightmost entry', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '1.1.1.1, 198.51.100.4' }), 1)).toBe(
      '198.51.100.4',
    );
  });

  test('blank entries are skipped and x-real-ip is only a fallback', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': ' , 198.51.100.4 ,' }), 1)).toBe(
      '198.51.100.4',
    );
    expect(clientIpFromHeaders(headers({ 'x-real-ip': '198.51.100.9' }), 2)).toBe('198.51.100.9');
    expect(clientIpFromHeaders(headers({}), 2)).toBeNull();
  });
});

describe('bucket key vs stored address', () => {
  test('clientKeyFromHeaders returns the address, or unknown when no header is set', () => {
    expect(clientKeyFromHeaders(headers({ 'x-forwarded-for': '192.0.2.1, 203.0.113.9, 198.51.100.7' }))).toBe(
      '203.0.113.9',
    );
    expect(clientKeyFromHeaders(headers({}))).toBe('unknown');
  });

  test('requestClientKey falls back to unknown; requestClientIp stays null', async () => {
    const app = new Hono();
    app.get('/', (c) => c.json({ key: requestClientKey(c), ip: requestClientIp(c) }));
    const bare = await (await app.request('/')).json();
    expect(bare).toEqual({ key: 'unknown', ip: null });
    const withHeader = await (
      await app.request('/', { headers: { 'x-forwarded-for': '192.0.2.1, 203.0.113.9, 198.51.100.7' } })
    ).json();
    expect(withHeader).toEqual({ key: '203.0.113.9', ip: '203.0.113.9' });
  });
});
