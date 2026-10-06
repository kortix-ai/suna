import { beforeEach, expect, test } from 'bun:test';

import { armPendingMfaAction, clearPendingMfaAction, runPendingMfaAction } from './mfa-pending-action';

beforeEach(clearPendingMfaAction);

test('a cancelled action does not run at the next verification', () => {
  const ran: string[] = [];
  armPendingMfaAction(() => ran.push('remove-factor'));
  clearPendingMfaAction();
  armPendingMfaAction(() => ran.push('sign-out-others'));
  runPendingMfaAction();
  expect(ran).toEqual(['sign-out-others']);
});

test('an unverified-then-replaced action never runs, and each runs once', () => {
  const ran: string[] = [];
  armPendingMfaAction(() => ran.push('a'));
  armPendingMfaAction(() => ran.push('b'));
  runPendingMfaAction();
  runPendingMfaAction();
  expect(ran).toEqual(['b']);
});
