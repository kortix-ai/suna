import test from 'node:test';
import assert from 'node:assert/strict';

import { readCallbackTokens } from './callback-tokens.ts';

test('readCallbackTokens reads tokens from the hash fragment', () => {
  assert.deepEqual(
    readCallbackTokens('kortix://auth/callback?state=s1#access_token=a1&refresh_token=r1'),
    { access_token: 'a1', refresh_token: 'r1' },
  );
});

test('readCallbackTokens reads tokens from the query string (web handoff bounce)', () => {
  assert.deepEqual(
    readCallbackTokens(
      'kortix://auth/callback?mobile_callback=1&state=s1&access_token=a1&refresh_token=r1',
    ),
    { access_token: 'a1', refresh_token: 'r1' },
  );
});

test('readCallbackTokens returns null when the refresh token is missing', () => {
  assert.equal(readCallbackTokens('kortix://auth/callback?state=s1#access_token=a1'), null);
  assert.equal(readCallbackTokens('kortix://auth/callback?state=s1&access_token=a1'), null);
});

test('readCallbackTokens returns null for a string that is not a URL', () => {
  assert.equal(readCallbackTokens('not a url'), null);
});
