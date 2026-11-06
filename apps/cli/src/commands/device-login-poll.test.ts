import { describe, expect, test } from 'bun:test';

import { DeviceRequestError } from '../api/sdk.ts';
import { pollDeviceGrant, type DevicePollDeps } from './device-login-poll.ts';

/** A fake clock: sleep advances time instantly, so no test waits on real time. */
function harness(answers: Array<{ token?: string; error?: string } | Error>) {
  let t = 0;
  const sleeps: number[] = [];
  const polls: number[] = [];
  const deps: DevicePollDeps = {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    poll: async () => {
      polls.push(t);
      const next = answers.shift() ?? { error: 'authorization_pending' };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { deps, sleeps, polls };
}

describe('pollDeviceGrant', () => {
  test('returns the token after pending answers', async () => {
    const h = harness([{ error: 'authorization_pending' }, { token: 'kortix_pat_x' }]);
    expect(await pollDeviceGrant({ interval: 5, expires_in: 600 }, h.deps)).toBe('kortix_pat_x');
    expect(h.sleeps).toEqual([5000, 5000]);
  });

  test('keeps polling through a network error and a 5xx', async () => {
    const h = harness([
      new TypeError('fetch failed'),
      new DeviceRequestError(502),
      new DeviceRequestError(503),
      { token: 'kortix_pat_ok' },
    ]);
    expect(await pollDeviceGrant({ interval: 5, expires_in: 600 }, h.deps)).toBe('kortix_pat_ok');
    expect(h.polls.length).toBe(4);
  });

  test('backs off on consecutive transient errors and resets after a good answer', async () => {
    const h = harness([new TypeError('x'), new TypeError('x'), { error: 'authorization_pending' }, { token: 't' }]);
    await pollDeviceGrant({ interval: 5, expires_in: 600 }, h.deps);
    expect(h.sleeps).toEqual([5000, 10000, 20000, 5000]);
  });

  test('gives up after 5 consecutive transient errors', async () => {
    const h = harness(Array.from({ length: 5 }, () => new DeviceRequestError(500)));
    await expect(pollDeviceGrant({ interval: 5, expires_in: 600 }, h.deps)).rejects.toThrow(/HTTP 500/);
    expect(h.polls.length).toBe(5);
  });

  test('a 429 is slow_down, not a failure', async () => {
    const h = harness([new DeviceRequestError(429), { token: 't' }]);
    expect(await pollDeviceGrant({ interval: 5, expires_in: 600 }, h.deps)).toBe('t');
    expect(h.sleeps).toEqual([5000, 10000]);
  });

  test('a 4xx other than 429 stops at once', async () => {
    const h = harness([new DeviceRequestError(400)]);
    await expect(pollDeviceGrant({ interval: 5, expires_in: 600 }, h.deps)).rejects.toThrow(/HTTP 400/);
    expect(h.polls.length).toBe(1);
  });

  test('a missing interval polls every 5 s, never at 0 ms', async () => {
    const h = harness([{ error: 'authorization_pending' }, { token: 't' }]);
    await pollDeviceGrant({ interval: undefined, expires_in: 600 }, h.deps);
    expect(h.sleeps).toEqual([5000, 5000]);
  });

  test('a missing expires_in falls back to 600 s instead of expiring at once', async () => {
    const h = harness([{ token: 't' }]);
    expect(await pollDeviceGrant({ interval: 5, expires_in: undefined }, h.deps)).toBe('t');
  });

  test('polls inside the last window instead of skipping it', async () => {
    const h = harness([]);
    await expect(pollDeviceGrant({ interval: 5, expires_in: 12 }, h.deps)).rejects.toThrow(/expired/);
    // 5 s, 10 s, then a shortened sleep to 12 s for the last poll.
    expect(h.polls).toEqual([5000, 10000, 12000]);
  });

  test('server refusals read as sentences', async () => {
    await expect(pollDeviceGrant({ interval: 5, expires_in: 600 }, harness([{ error: 'access_denied' }]).deps)).rejects.toThrow(/denied in the browser/);
    await expect(pollDeviceGrant({ interval: 5, expires_in: 600 }, harness([{ error: 'expired_token' }]).deps)).rejects.toThrow(/expired/);
  });
});
