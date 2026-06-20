import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMobileRegistrationUrl,
  isMobileAuthCallbackUrl,
} from './web-registration-handoff.ts';

test('buildMobileRegistrationUrl carries the native callback state to web auth', () => {
  assert.equal(
    buildMobileRegistrationUrl('https://kortix.com/', 'native-state'),
    'https://kortix.com/auth?mobile_callback=1&state=native-state',
  );
});

test('isMobileAuthCallbackUrl accepts the custom scheme callback', () => {
  assert.equal(
    isMobileAuthCallbackUrl('kortix://auth/callback?state=native-state'),
    true,
  );
});

test('isMobileAuthCallbackUrl accepts only opted-in Kortix HTTPS callbacks', () => {
  assert.equal(
    isMobileAuthCallbackUrl('https://kortix.com/auth/callback?mobile_callback=1&state=native-state'),
    true,
  );
  assert.equal(
    isMobileAuthCallbackUrl('https://evil.example/auth/callback?mobile_callback=1&state=native-state'),
    false,
  );
  assert.equal(
    isMobileAuthCallbackUrl('https://kortix.com/auth/callback?state=native-state'),
    false,
  );
});
