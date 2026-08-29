import { beforeEach, describe, expect, test } from 'bun:test';
import {
  claimPoller,
  isPollOwner,
  releasePoller,
  resetPollOwners,
  subscribePollOwner,
} from './poll-owner';

const SCOPE = 'P1/S1';

beforeEach(() => {
  resetPollOwners();
});

describe('the poll-owner registry', () => {
  test('the first claimant owns the cadence and the rest do not', () => {
    claimPoller(SCOPE, 'a');
    claimPoller(SCOPE, 'b');
    claimPoller(SCOPE, 'c');
    // Three hooks mount the SAME `/turn` query on a session route. TanStack
    // schedules `refetchInterval` PER OBSERVER, so three observers meant three
    // timers on one key — measured as 6 `/turn` reads inside one 25s open.
    expect(isPollOwner(SCOPE, 'a')).toBe(true);
    expect(isPollOwner(SCOPE, 'b')).toBe(false);
    expect(isPollOwner(SCOPE, 'c')).toBe(false);
  });

  test('ownership passes to the next claimant when the owner leaves', () => {
    claimPoller(SCOPE, 'a');
    claimPoller(SCOPE, 'b');
    releasePoller(SCOPE, 'a');
    // The cadence must SURVIVE the owner unmounting. A session whose only
    // poller left would stop learning that a turn started elsewhere.
    expect(isPollOwner(SCOPE, 'b')).toBe(true);
  });

  test('a non-owner leaving does not disturb the owner', () => {
    claimPoller(SCOPE, 'a');
    claimPoller(SCOPE, 'b');
    releasePoller(SCOPE, 'b');
    expect(isPollOwner(SCOPE, 'a')).toBe(true);
  });

  test('claiming twice with the same id does not create a second owner', () => {
    claimPoller(SCOPE, 'a');
    claimPoller(SCOPE, 'a');
    claimPoller(SCOPE, 'b');
    releasePoller(SCOPE, 'a');
    expect(isPollOwner(SCOPE, 'b')).toBe(true);
  });

  test('scopes are independent — one session never owns another', () => {
    claimPoller(SCOPE, 'a');
    claimPoller('P1/S2', 'b');
    expect(isPollOwner(SCOPE, 'a')).toBe(true);
    expect(isPollOwner('P1/S2', 'b')).toBe(true);
    expect(isPollOwner('P1/S2', 'a')).toBe(false);
  });

  test('an unclaimed id never owns anything', () => {
    expect(isPollOwner(SCOPE, 'ghost')).toBe(false);
    claimPoller(SCOPE, 'a');
    expect(isPollOwner(SCOPE, 'ghost')).toBe(false);
  });

  test('subscribers are notified when ownership changes, and only then', () => {
    let notifications = 0;
    const unsubscribe = subscribePollOwner(SCOPE, () => {
      notifications += 1;
    });
    claimPoller(SCOPE, 'a');
    expect(notifications).toBe(1);
    // A second claimant does not change WHO owns it, so nothing re-renders.
    claimPoller(SCOPE, 'b');
    expect(notifications).toBe(1);
    releasePoller(SCOPE, 'a');
    expect(notifications).toBe(2);
    unsubscribe();
    releasePoller(SCOPE, 'b');
    expect(notifications).toBe(2);
  });

  test('a scope with no claimants left is forgotten', () => {
    claimPoller(SCOPE, 'a');
    releasePoller(SCOPE, 'a');
    // Leak hygiene: a per-session registry that never shrinks is a per-session
    // leak. Re-claiming starts clean.
    claimPoller(SCOPE, 'b');
    expect(isPollOwner(SCOPE, 'b')).toBe(true);
  });
});
