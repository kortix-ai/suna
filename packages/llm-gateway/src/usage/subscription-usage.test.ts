import { describe, expect, test } from 'bun:test';
import { createUsageReporter, subscriptionUsageFromHeaders, type SubscriptionUsage } from './subscription-usage';

const NOW = Date.parse('2026-11-04T14:00:00Z');

describe('subscriptionUsageFromHeaders', () => {
  test('a ChatGPT response names its 5-hour and weekly windows', () => {
    const usage = subscriptionUsageFromHeaders(new Headers({
      'x-codex-primary-used-percent': '41.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-used-percent': '12',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': String(NOW / 1000 + 86_400),
    }), NOW);
    expect(usage).toEqual({
      windows: [
        { id: 'five_hour', window_minutes: 300, used_percent: 41.5, resets_at: '2026-11-04T15:00:00.000Z' },
        { id: 'weekly', window_minutes: 10080, used_percent: 12, resets_at: '2026-11-05T14:00:00.000Z' },
      ],
      limited: false,
      observed_at: '2026-11-04T14:00:00.000Z',
      source: 'response',
    });
  });

  test('a ChatGPT window at 100% is limited', () => {
    const usage = subscriptionUsageFromHeaders(new Headers({
      'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300',
    }), NOW);
    expect(usage?.limited).toBe(true);
    expect(usage?.windows[0]).toEqual({ id: 'five_hour', window_minutes: 300, used_percent: 100, resets_at: null });
  });

  test('a Claude response names its unified windows; utilization is a fraction', () => {
    const usage = subscriptionUsageFromHeaders(new Headers({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.72',
      'anthropic-ratelimit-unified-5h-reset': String(NOW / 1000 + 7200),
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.18',
      'anthropic-ratelimit-unified-7d-reset': String(NOW / 1000 + 3 * 86_400),
    }), NOW);
    expect(usage).toEqual({
      windows: [
        { id: 'five_hour', window_minutes: 300, used_percent: 72, resets_at: '2026-11-04T16:00:00.000Z' },
        { id: 'weekly', window_minutes: 10080, used_percent: 18, resets_at: '2026-11-07T14:00:00.000Z' },
      ],
      limited: false,
      observed_at: '2026-11-04T14:00:00.000Z',
      source: 'response',
    });
  });

  test('a Claude response the account refuses is limited', () => {
    const usage = subscriptionUsageFromHeaders(new Headers({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
    }), NOW);
    expect(usage?.limited).toBe(true);
    expect(usage?.windows[0]?.used_percent).toBe(100);
  });

  test('a response without usage headers yields null', () => {
    expect(subscriptionUsageFromHeaders(new Headers({ 'content-type': 'application/json' }), NOW)).toBeNull();
    expect(subscriptionUsageFromHeaders(new Headers({ 'x-codex-primary-used-percent': 'garbage' }), NOW)).toBeNull();
  });

  // A reset time `Date` cannot represent is no reset time: the window keeps its
  // used_percent and the served answer stands, instead of a RangeError escaping
  // the post-response usage read.
  test('a ChatGPT reset time Date cannot represent is dropped, the window stays', () => {
    const beyondDate = '1e15';
    expect(subscriptionUsageFromHeaders(new Headers({
      'x-codex-primary-used-percent': '41',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': beyondDate,
      'x-codex-secondary-used-percent': '12',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': beyondDate,
    }), NOW)?.windows).toEqual([
      { id: 'five_hour', window_minutes: 300, used_percent: 41, resets_at: null },
      { id: 'weekly', window_minutes: 10080, used_percent: 12, resets_at: null },
    ]);
  });

  test('a Claude reset time Date cannot represent is dropped, the window stays', () => {
    expect(subscriptionUsageFromHeaders(new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.72',
      'anthropic-ratelimit-unified-5h-reset': '1e15',
    }), NOW)?.windows).toEqual([
      { id: 'five_hour', window_minutes: 300, used_percent: 72, resets_at: null },
    ]);
  });
});

describe('createUsageReporter', () => {
  const usage = (percent: number, at = NOW): SubscriptionUsage => ({
    windows: [{ id: 'five_hour', window_minutes: 300, used_percent: percent, resets_at: null }],
    limited: false, observed_at: new Date(at).toISOString(), source: 'response',
  });

  test('reports the first snapshot, skips an equal one inside the interval, reports a change', async () => {
    const sent: Array<[string, number]> = [];
    let now = NOW;
    const report = createUsageReporter<null>(async (_context, secretId, snapshot) => { sent.push([secretId, snapshot.windows[0]!.used_percent]); }, { now: () => now });
    report(null, 'acc-1', usage(40));
    now += 5_000;
    report(null, 'acc-1', usage(40.4));
    report(null, 'acc-1', usage(42));
    report(null, 'acc-2', usage(1));
    now += 61_000;
    report(null, 'acc-1', usage(42));
    await Promise.resolve();
    expect(sent).toEqual([['acc-1', 40], ['acc-1', 42], ['acc-2', 1], ['acc-1', 42]]);
  });

  test('a failed report never throws to the caller', async () => {
    const errors: string[] = [];
    const report = createUsageReporter<null>(async () => { throw new Error('down'); }, { now: () => NOW, logger: { warn: (message) => errors.push(message) } });
    expect(() => report(null, 'acc-1', usage(1))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
  });
});
