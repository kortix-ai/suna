import { afterEach, describe, expect, test } from 'bun:test';

import { platformConfig } from '@kortix/sdk';

import {
  __resetAuthTokenCacheForTests,
  __setFetchTokenForTests,
  getSupabaseAccessToken,
} from './auth-token';
import { ensureKortixConfigured } from './kortix-config';
import { testUiTranslator } from '@/i18n/test-translator';

/**
 * The SDK's `send()` replays a 401 once with "a fresh token": it calls
 * `getToken.invalidate(rejectedToken)` and then asks `getToken()` again
 * (packages/sdk/src/core/http/transport.ts). That contract only works when the
 * host's getter actually carries `invalidate`. Web's getter is backed by the
 * 30 s token cache in `auth-token.ts`, so without the wiring the replay
 * re-sends the same dead token the API just refused — every request of a
 * page-load fan-out 401s twice against one dead credential, which is the warn
 * burst the API logs for each rejection (KRTX-1040).
 */
describe('ensureKortixConfigured: the 401 replay seam', () => {
  afterEach(() => {
    __resetAuthTokenCacheForTests();
  });

  test('getToken carries the invalidate hook the transport calls on a 401', () => {
    ensureKortixConfigured(testUiTranslator);
    const { getToken } = platformConfig();
    expect(typeof getToken).toBe('function');
    expect(typeof getToken.invalidate).toBe('function');
  });

  test('invalidate drops the cached token so the replay asks for a fresh one', async () => {
    let fetches = 0;
    __setFetchTokenForTests(() => {
      fetches++;
      return Promise.resolve(fetches === 1 ? 'dead-token' : 'fresh-token');
    });
    ensureKortixConfigured(testUiTranslator);

    expect(await getSupabaseAccessToken()).toBe('dead-token');
    // A second call inside the 30 s TTL is served from the cache — this is the
    // token a 401 replay would re-send without the invalidate hook.
    expect(await getSupabaseAccessToken()).toBe('dead-token');
    expect(fetches).toBe(1);

    platformConfig().getToken.invalidate!('dead-token');

    expect(await getSupabaseAccessToken()).toBe('fresh-token');
    expect(fetches).toBe(2);
  });
});
