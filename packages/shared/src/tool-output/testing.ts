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
 * The CPU cost of `run`, in milliseconds.
 *
 * CPU time, not wall time: a loaded box costs wall time without costing work
 * (GC threads, preemption under the packages lane's concurrent waves). The
 * worst legitimate case in these suites measures 107.8 ms CPU; 250 ms is
 * ~2.3x headroom, and a quadratic blowup is 100-1000x over, so the teeth stay.
 * Exported so the budget's semantics are testable (testing.test.ts pins both
 * sides: a preempted case measures ~0 CPU, a real burn measures over budget).
 */
export function cpuCostOf(run: () => unknown): number {
  const started = process.cpuUsage();
  run();
  const cpu = process.cpuUsage(started);
  return (cpu.user + cpu.system) / 1000;
}

/** A test that fails when `run` burns 250 ms of CPU or more. */
export function within(label: string, run: () => unknown): void {
  test(label, () => {
    expect(cpuCostOf(run)).toBeLessThan(250);
  });
}
