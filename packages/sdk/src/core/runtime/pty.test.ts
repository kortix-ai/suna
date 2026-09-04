import { describe, expect, mock, test } from 'bun:test';

mock.module('../http/auth', () => ({
  authenticatedFetch: async () => new Response('[]'),
  getAuthToken: async () => 'test-token',
}));

import { getKortixPtyWebSocketUrl } from './pty';

const BASE = 'https://api.example.com/v1/p/sbx_1/8000';

describe('getKortixPtyWebSocketUrl', () => {
  test('builds the wss attach url with the auth token', async () => {
    const url = new URL(await getKortixPtyWebSocketUrl('kpty_1', BASE));
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/v1/p/sbx_1/8000/kortix/pty/kpty_1/connect');
    expect(url.searchParams.get('token')).toBe('test-token');
    expect(url.searchParams.get('wake')).toBeNull();
  });

  // A parked sandbox refuses the upgrade with 503, which a browser can only
  // report as close code 1006 — so an attach that never says "this is a human
  // opening a terminal" loops forever against a box nothing will wake. Only a
  // user-initiated connect (first mount, "Reconnect now") carries `wake=1`;
  // automatic backoff retries must not, or polling would resurrect boxes.
  test('marks a user-initiated attach with wake=1', async () => {
    const url = new URL(await getKortixPtyWebSocketUrl('kpty_1', BASE, { wake: true }));
    expect(url.searchParams.get('wake')).toBe('1');
    expect(url.searchParams.get('token')).toBe('test-token');
  });

  test('an explicit non-wake attach stays unmarked', async () => {
    const url = new URL(await getKortixPtyWebSocketUrl('kpty_1', BASE, { wake: false }));
    expect(url.searchParams.get('wake')).toBeNull();
  });
});
