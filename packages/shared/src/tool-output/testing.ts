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

/** A test that fails when `run` takes long enough to freeze the renderer. */
export function within(label: string, run: () => unknown): void {
  test(label, () => {
    const started = performance.now();
    run();
    // The guard is against a renderer FREEZE (a synchronous parse measured in
    // seconds), not against the sandbox's own load: the two slowest inputs
    // here measure 56 ms and 44 ms isolated, and 108-164 ms under the six
    // concurrent test lanes of one full `pnpm test` run on a 6-core sandbox.
    // 250 ms keeps a 1.5x margin over that worst observed load spike and
    // still fails 4x before anything a person would perceive as a freeze.
    expect(performance.now() - started).toBeLessThan(250);
  });
}
