import { describe, expect, mock, test } from 'bun:test';

import * as realAuth from '../http/auth';

let invalidated = 0;
let refreshed = 0;
mock.module('../http/auth', () => ({
  ...realAuth,
  invalidateTokenCache: () => {
    invalidated++;
  },
  getSupabaseAccessToken: async () => {
    refreshed++;
    return 'fresh';
  },
}));

const { openEventStream } = await import('./event-stream');

const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function clientFailingWith(error: unknown) {
  return { global: { event: async () => { throw error; } } } as never;
}

describe('openEventStream auth recovery (04#9)', () => {
  test('a 401 carried on the vendor error cause invalidates the token and fetches a fresh one', async () => {
    invalidated = 0;
    refreshed = 0;
    const handle = openEventStream({
      client: clientFailingWith(new Error('GET /global/event failed', { cause: { status: 401 } })),
      onEvent: () => {},
    });
    await tick();
    handle.close();
    expect(invalidated).toBe(1);
    expect(refreshed).toBe(1);
  });

  test('message text that merely contains 401 is not an auth failure', async () => {
    invalidated = 0;
    const handle = openEventStream({
      client: clientFailingWith(new Error('session 4012 not found', { cause: { status: 404 } })),
      onEvent: () => {},
    });
    await tick();
    handle.close();
    expect(invalidated).toBe(0);
  });
});
