import { describe, expect, test } from 'bun:test';
import { shortLivedObservation } from './observation-cache';

describe('provider catalog observation cache', () => {
  test('deduplicates concurrent reads and briefly reuses the result', async () => {
    let calls = 0;
    const observe = shortLivedObservation(async () => {
      calls += 1;
      await Promise.resolve();
      return ['template-a', 'template-b'];
    });

    const [first, second] = await Promise.all([observe(), observe()]);
    expect(first).toEqual(second);
    expect(await observe()).toEqual(first);
    expect(calls).toBe(1);
  });

  test('never caches a failed provider read', async () => {
    let calls = 0;
    const observe = shortLivedObservation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
      return ['recovered'];
    });

    await expect(observe()).rejects.toThrow('temporary failure');
    expect(await observe()).toEqual(['recovered']);
    expect(calls).toBe(2);
  });

  test('invalidation prevents an older in-flight read from restoring stale data', async () => {
    let calls = 0;
    let resolveStale!: (value: string[]) => void;
    const staleResult = new Promise<string[]>((resolve) => {
      resolveStale = resolve;
    });
    const observe = shortLivedObservation(async () => {
      calls += 1;
      return calls === 1 ? staleResult : ['fresh'];
    });

    const stale = observe();
    observe.invalidate();
    expect(await observe()).toEqual(['fresh']);
    resolveStale(['stale']);
    expect(await stale).toEqual(['stale']);
    expect(await observe()).toEqual(['fresh']);
    expect(calls).toBe(2);
  });
});
