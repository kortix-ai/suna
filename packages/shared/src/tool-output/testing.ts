import { expect, test } from 'bun:test';

// Support for the parity and timing tests in this folder. The barrel does not
// export it: only `*.test.ts` files import it.

/** Deterministic PRNG (mulberry32), so a failing case reproduces. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random choices from one seeded PRNG. */
export function chooser(seed: number) {
  const next = random(seed);
  const pick = <T>(options: readonly T[]): T => options[Math.floor(next() * options.length)] as T;
  /** Up to `max` tokens from `options`, joined. */
  const some = (options: readonly string[], max: number): string => {
    let text = '';
    const length = Math.floor(next() * (max + 1));
    for (let i = 0; i < length; i++) text += pick(options);
    return text;
  };
  return { next, pick, some };
}

/**
 * A test that fails when `run` burns 250 ms of CPU or more.
 *
 * CPU time, not wall time: the old 100 ms wall budget sat ~1.7x over the worst
 * legitimate case (57 ms idle) and failed under the packages lane's concurrent
 * waves, where a loaded box costs wall time without costing work (107.8 ms CPU
 * with GC threads at 82 ms wall). 250 ms is ~2.3x the measured worst case; a
 * quadratic blowup is 100-1000x over, so the teeth stay.
 */
export function within(label: string, run: () => unknown): void {
  test(label, () => {
    const started = process.cpuUsage();
    run();
    const cpu = process.cpuUsage(started);
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(250);
  });
}
