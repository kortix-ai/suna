import { describe, expect, test } from 'bun:test';
import { LEAVE_AT_PERCENT, headroom, routeAccounts } from './account-routing';

const NOW = Date.parse('2026-11-04T16:00:00Z');
const later = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const usage = (fiveHour: number, weekly = 0, extra: { limited?: boolean; resetHours?: number } = {}) => ({
  windows: [
    { id: 'five_hour', window_minutes: 300, used_percent: fiveHour, resets_at: later(extra.resetHours ?? 2) },
    { id: 'weekly', window_minutes: 10080, used_percent: weekly, resets_at: later(100) },
  ],
  limited: extra.limited ?? false,
  observed_at: new Date(NOW).toISOString(),
  source: 'response' as const,
});
const account = (secretId: string, u?: unknown) => ({ secretId, usage: u });
const order = (accounts: ReturnType<typeof account>[], pinned?: string) => {
  const routed = routeAccounts(accounts, pinned, NOW);
  return { ids: routed.ordered.map((a) => a.secretId), pin: routed.pin };
};

describe('headroom', () => {
  test('the fullest open window; a window that already reset counts as empty', () => {
    expect(headroom(usage(40, 70), NOW)).toEqual({ usedPercent: 70, exhausted: false });
    expect(headroom(usage(100, 10, { resetHours: -1 }), NOW)).toEqual({ usedPercent: 10, exhausted: false });
    expect(headroom(usage(100, 10), NOW).exhausted).toBe(true);
  });

  test('a limited account is exhausted until its windows reset; no usage on record is empty', () => {
    expect(headroom(usage(80, 80, { limited: true }), NOW).exhausted).toBe(true);
    expect(headroom({ ...usage(80, 0, { limited: true }), windows: [{ id: 'five_hour', window_minutes: 300, used_percent: 80, resets_at: later(-1) }] }, NOW))
      .toEqual({ usedPercent: 0, exhausted: false });
    expect(headroom(null, NOW)).toEqual({ usedPercent: 0, exhausted: false });
    expect(headroom({ unexpected: true }, NOW)).toEqual({ usedPercent: 0, exhausted: false });
  });
});

describe('routeAccounts: a session stays on its account until that account runs out', () => {
  test('a new session starts on the account with the most headroom, ties in the given order', () => {
    expect(order([account('a', usage(60)), account('b', usage(20)), account('c', usage(20))])).toEqual({ ids: ['b', 'c', 'a'], pin: 'b' });
    expect(order([account('a'), account('b')])).toEqual({ ids: ['a', 'b'], pin: 'a' });
  });

  test('it stays on its pinned account even when another has more headroom', () => {
    expect(order([account('a', usage(70)), account('b', usage(5))], 'a')).toEqual({ ids: ['a', 'b'], pin: 'a' });
  });

  test(`it leaves at ${LEAVE_AT_PERCENT}% of any open window for an account with room, and stays there`, () => {
    const moved = order([account('a', usage(20, 96)), account('b', usage(30)), account('c', usage(10))], 'a');
    expect(moved).toEqual({ ids: ['c', 'b', 'a'], pin: 'c' });
    expect(order([account('a', usage(20, 96)), account('b', usage(30)), account('c', usage(40))], 'c').pin).toBe('c');
  });

  test('a nearly spent account keeps the session when every other is as full', () => {
    expect(order([account('a', usage(96)), account('b', usage(97))], 'a').pin).toBe('a');
    expect(order([account('a', usage(96)), account('b', usage(100))], 'a').pin).toBe('a');
  });

  test('a limited pinned account hands over at once; exhausted accounts go last, never nowhere', () => {
    expect(order([account('a', usage(50, 0, { limited: true })), account('b', usage(80))], 'a')).toEqual({ ids: ['b', 'a'], pin: 'b' });
    expect(order([account('a', usage(100)), account('b', usage(100, 0, { limited: true }))], 'a').ids).toEqual(['a', 'b']);
  });

  test('a pin that is no longer ready (resting, removed from the pool) moves to the best ready account', () => {
    expect(order([account('b', usage(50)), account('c', usage(10))], 'a')).toEqual({ ids: ['c', 'b'], pin: 'c' });
  });

  test('after its window resets, the account it left is empty again but the session stays where it moved', () => {
    expect(order([account('a', usage(99, 0, { resetHours: -1 })), account('c', usage(30))], 'c').pin).toBe('c');
  });

  test('nothing ready: no order, no pin', () => {
    expect(routeAccounts([], 'a', NOW)).toEqual({ ordered: [], pin: undefined });
  });
});
