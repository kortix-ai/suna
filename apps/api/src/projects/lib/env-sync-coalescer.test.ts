import { describe, expect, test } from 'bun:test';
import { createCoalescedRunner } from './env-sync-coalescer';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createCoalescedRunner — the env-push storm breaker', () => {
  test('an idle key past its interval runs immediately', async () => {
    const runs: string[] = [];
    const coalesced = createCoalescedRunner<string>({
      run: async (key) => {
        runs.push(key);
        return `ok:${key}`;
      },
      minIntervalMs: () => 0,
    });
    expect(await coalesced('p1')).toBe('ok:p1');
    expect(runs).toEqual(['p1']);
  });

  test('a burst during one in-flight run collapses to ONE trailing run shared by every caller', async () => {
    let started = 0;
    const gates: Array<ReturnType<typeof deferred<number>>> = [];
    const coalesced = createCoalescedRunner<number>({
      run: () => {
        const gate = deferred<number>();
        gates.push(gate);
        started += 1;
        return gate.promise;
      },
      minIntervalMs: () => 0,
    });

    const first = coalesced('p1');
    const burst = [coalesced('p1'), coalesced('p1'), coalesced('p1'), coalesced('p1')];
    expect(started).toBe(1);

    gates[0]!.resolve(1);
    expect(await first).toBe(1);
    await tick();
    expect(started).toBe(2);

    gates[1]!.resolve(2);
    expect(await Promise.all(burst)).toEqual([2, 2, 2, 2]);
    expect(started).toBe(2);
  });

  test('refreshModels=true from ANY coalesced caller survives into the shared run', async () => {
    const seen: boolean[] = [];
    const gates: Array<ReturnType<typeof deferred<null>>> = [];
    const coalesced = createCoalescedRunner<null>({
      run: (_key, opts) => {
        seen.push(opts.refreshModels);
        const gate = deferred<null>();
        gates.push(gate);
        return gate.promise;
      },
      minIntervalMs: () => 0,
    });
    void coalesced('p1');
    const a = coalesced('p1', { refreshModels: false });
    const b = coalesced('p1', { refreshModels: true });
    const c = coalesced('p1');
    gates[0]!.resolve(null);
    await tick();
    gates[1]!.resolve(null);
    await Promise.all([a, b, c]);
    expect(seen).toEqual([false, true]);
  });

  test('a second run never starts before minIntervalMs since the first START', async () => {
    const startTimes: number[] = [];
    const coalesced = createCoalescedRunner<null>({
      run: async () => {
        startTimes.push(Date.now());
        return null;
      },
      minIntervalMs: () => 60,
    });
    await coalesced('p1');
    const trailing = coalesced('p1');
    await trailing;
    expect(startTimes).toHaveLength(2);
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(50);
  });

  test('a rejected run rejects exactly its awaiters and does not poison the key', async () => {
    let calls = 0;
    const coalesced = createCoalescedRunner<string>({
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('provider down');
        return 'recovered';
      },
      minIntervalMs: () => 0,
    });
    await expect(coalesced('p1')).rejects.toThrow('provider down');
    await sleep(5);
    expect(await coalesced('p1')).toBe('recovered');
  });

  test('a rejected in-flight run still releases the queued trailing run', async () => {
    const gate = deferred<string>();
    let calls = 0;
    const coalesced = createCoalescedRunner<string>({
      run: () => {
        calls += 1;
        return calls === 1 ? gate.promise : Promise.resolve('trailing-ok');
      },
      minIntervalMs: () => 0,
    });
    const failing = coalesced('p1');
    const queued = coalesced('p1');
    gate.reject(new Error('boom'));
    await expect(failing).rejects.toThrow('boom');
    expect(await queued).toBe('trailing-ok');
  });

  test('keys are independent — one project cooling down never delays another', async () => {
    const runs: string[] = [];
    const coalesced = createCoalescedRunner<null>({
      run: async (key) => {
        runs.push(key);
        return null;
      },
      minIntervalMs: () => 10_000,
    });
    await coalesced('p1');
    await coalesced('p2');
    expect(runs).toEqual(['p1', 'p2']);
  });

  test('the incident shape: 50 rapid writes cost 2 runs, not 50', async () => {
    let runsStarted = 0;
    const gates: Array<ReturnType<typeof deferred<null>>> = [];
    const coalesced = createCoalescedRunner<null>({
      run: () => {
        runsStarted += 1;
        const gate = deferred<null>();
        gates.push(gate);
        return gate.promise;
      },
      minIntervalMs: () => 0,
    });
    const all: Array<Promise<null>> = [];
    for (let i = 0; i < 50; i++) all.push(coalesced('storm'));
    expect(runsStarted).toBe(1);
    gates[0]!.resolve(null);
    await tick();
    gates[1]!.resolve(null);
    await Promise.all(all);
    expect(runsStarted).toBe(2);
  });
});

describe('createCoalescedRunner — genuine-user safety properties', () => {
  test('NO LOST UPDATE: a write landing mid-run is always followed by a run that starts after it', async () => {
    const runStarts: number[] = [];
    const gates: Array<{ promise: Promise<null>; resolve: (v: null) => void }> = [];
    const coalesced = createCoalescedRunner<null>({
      run: () => {
        runStarts.push(Date.now());
        let resolve!: (v: null) => void;
        const promise = new Promise<null>((res) => {
          resolve = res;
        });
        gates.push({ promise, resolve });
        return promise;
      },
      minIntervalMs: () => 0,
    });

    const first = coalesced('p1');
    await new Promise((r) => setTimeout(r, 5));
    const writeAt = Date.now();
    const midRunWrite = coalesced('p1');
    gates[0]!.resolve(null);
    await first;
    await new Promise((r) => setTimeout(r, 0));
    gates[1]!.resolve(null);
    await midRunWrite;
    expect(runStarts).toHaveLength(2);
    expect(runStarts[1]!).toBeGreaterThanOrEqual(writeAt);
  });

  test('a lone write on a quiet project is never delayed by the interval', async () => {
    let ran = 0;
    const coalesced = createCoalescedRunner<null>({
      run: async () => {
        ran += 1;
        return null;
      },
      minIntervalMs: () => 60_000,
    });
    const t0 = Date.now();
    await coalesced('quiet-project');
    expect(ran).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
