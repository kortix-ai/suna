import { beforeEach, expect, test } from 'bun:test';

import { consumeAuthCallback, createAuthCallbackRedirect } from './callback-state';
import { armOAuthAdmission, disarmOAuthAdmission, takeOAuthAdmission } from './oauth-admission';

const stateOf = (redirect: string) => new URL(redirect).searchParams.get('state');

beforeEach(() => disarmOAuthAdmission());

test('the gate fires once per armed OAuth attempt', () => {
  armOAuthAdmission();
  expect(takeOAuthAdmission()).toBe(true);
  expect(takeOAuthAdmission()).toBe(false);
});

test('Android: a callback after the attempt gave up still passes the admission check', async () => {
  const redirect = await createAuthCallbackRedirect(undefined, { admission: true });
  armOAuthAdmission();
  disarmOAuthAdmission(); // the 2.5 s "not completed" resolve
  const result = await consumeAuthCallback(stateOf(redirect));
  expect(result).toEqual({ ok: true, admission: true });
  // The deep-link handler re-arms the gate from the stored state before setSession.
  expect(takeOAuthAdmission()).toBe(true);
});

test('a magic-link callback does not arm the admission check', async () => {
  const redirect = await createAuthCallbackRedirect({ terms_accepted: true });
  expect(await consumeAuthCallback(stateOf(redirect))).toEqual({ ok: true, admission: false });
  expect(takeOAuthAdmission()).toBe(false);
});

test('a wrong or reused state is rejected and arms nothing', async () => {
  const redirect = await createAuthCallbackRedirect(undefined, { admission: true });
  expect(await consumeAuthCallback('not-the-state')).toEqual({ ok: false, admission: false });
  expect(await consumeAuthCallback(stateOf(redirect))).toEqual({ ok: false, admission: false });
  expect(takeOAuthAdmission()).toBe(false);
});
