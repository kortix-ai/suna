import { afterEach, describe, expect, test } from 'bun:test';

import { configuredTimeoutMs, TimeoutError, withTimeout } from './with-timeout';

const ENV_KEY = 'KORTIX_TEST_TIMEOUT_BUDGET_MS';

afterEach(() => {
  delete process.env[ENV_KEY];
});

const never = () => new Promise<string>(() => {});
const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe('withTimeout', () => {
  test('resolves with the value when the work wins', async () => {
    await expect(withTimeout(after(10, 'ok'), 2_000)).resolves.toBe('ok');
  });

  test('rejects with a TimeoutError when the work never settles', async () => {
    const p = withTimeout(never(), 50, 'Daytona get(sbx-1)');
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    await p.catch((err: TimeoutError) => {
      expect(err.timeoutMs).toBe(50);
      expect(err.message).toContain('Daytona get(sbx-1)');
      expect(err.message).toContain('50ms');
    });
  });

  test('propagates the original rejection rather than masking it as a timeout', async () => {
    const boom = Promise.reject(new Error('upstream 503'));
    await expect(withTimeout(boom, 2_000)).rejects.toThrow('upstream 503');
  });

  test('abandons the WAIT but not the WORK — the losing promise still settles', async () => {
    let completed = false;
    const work = new Promise<string>((r) =>
      setTimeout(() => {
        completed = true;
        r('done');
      }, 120),
    );

    await expect(withTimeout(work, 30)).rejects.toBeInstanceOf(TimeoutError);
    expect(completed).toBe(false);

    await work;
    expect(completed).toBe(true);
  });

  test('an unhandled rejection from the abandoned promise does not escape', async () => {
    const doomed = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late boom')), 40));
    await expect(withTimeout(doomed, 10)).rejects.toBeInstanceOf(TimeoutError);
    await doomed.catch(() => {});
  });

  test('a non-positive budget means no bound at all, not instant failure', async () => {
    await expect(withTimeout(after(20, 'unbounded'), 0)).resolves.toBe('unbounded');
    await expect(withTimeout(after(20, 'negative'), -1)).resolves.toBe('negative');
  });

  test('does not keep the event loop alive after a fast win', async () => {
    const started = Date.now();
    await withTimeout(after(5, 'fast'), 60_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('configuredTimeoutMs', () => {
  test('uses the default when the env var is unset', () => {
    expect(configuredTimeoutMs(ENV_KEY, 20_000, 1_000)).toBe(20_000);
  });

  test('honours a configured value above the floor', () => {
    process.env[ENV_KEY] = '5000';
    expect(configuredTimeoutMs(ENV_KEY, 20_000, 1_000)).toBe(5_000);
  });

  test('clamps a value below the floor up to the floor', () => {
    process.env[ENV_KEY] = '200';
    expect(configuredTimeoutMs(ENV_KEY, 20_000, 1_000)).toBe(1_000);
  });

  test('falls back to the default for junk, zero, and negative values', () => {
    for (const raw of ['not-a-number', '0', '-5', '']) {
      process.env[ENV_KEY] = raw;
      expect(configuredTimeoutMs(ENV_KEY, 20_000, 1_000)).toBe(20_000);
    }
  });
});
