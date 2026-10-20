import { describe, expect, test } from 'bun:test';

import { canPollSessionStart } from './session-start-gate';

describe('canPollSessionStart', () => {
  test('does not poll before there is a user', () => {
    expect(canPollSessionStart({ hasUser: false, billingBlocked: false })).toBe(false);
  });

  test('polls for a signed-in account that is not blocked', () => {
    expect(canPollSessionStart({ hasUser: true, billingBlocked: false })).toBe(true);
  });

  test('stops polling for a sandbox that will never be provisioned', () => {
    expect(canPollSessionStart({ hasUser: true, billingBlocked: true })).toBe(false);
  });

  test('the boot sequence never interrupts an in-flight start', () => {
    // project-detail lands one round-trip before the account state it scopes.
    // The gate must not shut in that window — doing so disabled the /start
    // long-poll mid-wake and stalled the slowest sessions.
    const beforeDetail = canPollSessionStart({ hasUser: true, billingBlocked: false });
    const afterDetailBeforeAccountState = canPollSessionStart({
      hasUser: true,
      billingBlocked: false,
    });
    const afterAccountState = canPollSessionStart({ hasUser: true, billingBlocked: false });
    expect([beforeDetail, afterDetailBeforeAccountState, afterAccountState]).toEqual([
      true,
      true,
      true,
    ]);
  });

  test('a blocked account settles to false and stays there', () => {
    expect(canPollSessionStart({ hasUser: true, billingBlocked: true })).toBe(false);
    expect(canPollSessionStart({ hasUser: true, billingBlocked: true })).toBe(false);
  });
});
