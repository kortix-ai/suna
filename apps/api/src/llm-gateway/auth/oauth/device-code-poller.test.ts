import { describe, expect, test } from 'bun:test';
import { pollOAuthDeviceCodeFlow } from './device-code-poller';

// Real (not mocked) timers — bun:test has no vi.useFakeTimers equivalent for
// setTimeout scheduling. Tests are shaped to stay fast: the poller's
// MINIMUM_INTERVAL_MS floor is 1000ms, so any test that needs a second real
// poll costs at least ~1s; kept to the minimum number of such cases.

describe('pollOAuthDeviceCodeFlow — completion', () => {
  test('returns immediately when the first poll is already complete', async () => {
    const result = await pollOAuthDeviceCodeFlow({
      intervalSeconds: 5,
      expiresInSeconds: 30,
      poll: async () => ({ status: 'complete', value: 'token-a' }),
    });
    expect(result).toBe('token-a');
  });

  test('polls again after a pending response, without a slow_down', async () => {
    let calls = 0;
    const result = await pollOAuthDeviceCodeFlow({
      intervalSeconds: 1,
      expiresInSeconds: 30,
      poll: async () => {
        calls += 1;
        return calls === 1
          ? { status: 'pending' as const }
          : { status: 'complete' as const, value: 'token-b' };
      },
    });
    expect(result).toBe('token-b');
    expect(calls).toBe(2);
  }, 10_000);

  test('waitBeforeFirstPoll delays the first poll call', async () => {
    const start = Date.now();
    let firstPollAt: number | null = null;
    const result = await pollOAuthDeviceCodeFlow({
      intervalSeconds: 1,
      expiresInSeconds: 30,
      waitBeforeFirstPoll: true,
      poll: async () => {
        firstPollAt = Date.now();
        return { status: 'complete' as const, value: 'token-c' };
      },
    });
    expect(result).toBe('token-c');
    expect(firstPollAt).not.toBeNull();
    expect((firstPollAt as unknown as number) - start).toBeGreaterThanOrEqual(900);
  }, 10_000);
});

describe('pollOAuthDeviceCodeFlow — RFC 8628 §3.5 slow_down', () => {
  test('eventually completes after a slow_down response', async () => {
    let calls = 0;
    const result = await pollOAuthDeviceCodeFlow({
      intervalSeconds: 1,
      expiresInSeconds: 30,
      poll: async () => {
        calls += 1;
        if (calls === 1) return { status: 'slow_down' as const };
        return { status: 'complete' as const, value: 'token-d' };
      },
    });
    expect(result).toBe('token-d');
    expect(calls).toBe(2);
  }, 10_000);

  test('honors a server-provided slow_down interval over the client backoff', async () => {
    let calls = 0;
    const pollTimes: number[] = [];
    const result = await pollOAuthDeviceCodeFlow({
      intervalSeconds: 1,
      expiresInSeconds: 30,
      poll: async () => {
        calls += 1;
        pollTimes.push(Date.now());
        if (calls === 1) return { status: 'slow_down' as const, intervalSeconds: 1 };
        return { status: 'complete' as const, value: 'token-e' };
      },
    });
    expect(result).toBe('token-e');
    expect(calls).toBe(2);
    // Server said 1s (same as the floor), not the client's default +5s backoff.
    expect(pollTimes).toHaveLength(2);
    const [first, second] = pollTimes;
    expect((second ?? 0) - (first ?? 0)).toBeLessThan(4000);
  }, 10_000);
});

describe('pollOAuthDeviceCodeFlow — failure, timeout, cancellation', () => {
  test("throws the poller's own message on a failed status", async () => {
    await expect(
      pollOAuthDeviceCodeFlow({
        intervalSeconds: 5,
        expiresInSeconds: 30,
        poll: async () => ({ status: 'failed', message: 'access_denied' }),
      }),
    ).rejects.toThrow('access_denied');
  });

  test('times out with the plain message when no slow_down ever occurred', async () => {
    await expect(
      pollOAuthDeviceCodeFlow({
        intervalSeconds: 5,
        expiresInSeconds: 0,
        poll: async () => ({ status: 'pending' }),
      }),
    ).rejects.toThrow('Device flow timed out');
  });

  test('times out with the WSL/VM-clock-drift message after at least one slow_down', async () => {
    await expect(
      pollOAuthDeviceCodeFlow({
        intervalSeconds: 1,
        expiresInSeconds: 0.05,
        poll: async () => ({ status: 'slow_down' }),
      }),
    ).rejects.toThrow(/clock drift in WSL or VM environments/);
  });

  test('rejects with "Login cancelled" when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      pollOAuthDeviceCodeFlow({
        intervalSeconds: 5,
        expiresInSeconds: 30,
        poll: async () => ({ status: 'pending' }),
        signal: controller.signal,
      }),
    ).rejects.toThrow('Login cancelled');
  });

  test('cancels an in-flight wait when the signal aborts mid-poll', async () => {
    const controller = new AbortController();
    const resultPromise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 5,
      expiresInSeconds: 30,
      poll: async () => ({ status: 'pending' }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(resultPromise).rejects.toThrow('Login cancelled');
  }, 10_000);
});
