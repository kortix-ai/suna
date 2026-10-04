import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { requestClientIp, requestClientKey } from './client-ip';

describe('bucket key vs stored address', () => {
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
