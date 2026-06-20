import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMobileSessionHandoffUrl } from './mobile-handoff.ts';

test('buildMobileSessionHandoffUrl uses the verified HTTPS callback for a Kortix web origin', () => {
  assert.equal(
    buildMobileSessionHandoffUrl({
      origin: 'https://kortix.com',
      state: 'native-state',
      accessToken: 'access token',
      refreshToken: 'refresh token',
    }),
    'https://kortix.com/auth/callback?mobile_callback=1&state=native-state&access_token=access+token&refresh_token=refresh+token',
  );
});

test('buildMobileSessionHandoffUrl preserves the native scheme for non-production origins', () => {
  assert.equal(
    buildMobileSessionHandoffUrl({
      origin: 'http://localhost:3000',
      state: 'native-state',
      accessToken: 'access',
      refreshToken: 'refresh',
    }),
    'kortix://auth/callback?mobile_callback=1&state=native-state&access_token=access&refresh_token=refresh',
  );
});

test('buildMobileSessionHandoffUrl rejects incomplete sessions', () => {
  assert.equal(
    buildMobileSessionHandoffUrl({
      origin: 'https://kortix.com',
      state: 'native-state',
      accessToken: 'access',
      refreshToken: null,
    }),
    null,
  );
});
