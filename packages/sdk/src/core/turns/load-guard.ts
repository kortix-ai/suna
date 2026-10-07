import { expect } from 'bun:test';

/**
 * Wall-clock budget for the linear-time (ReDoS-class) guards, honest on a
 * loaded runner.
 *
 * A fixed `expect(elapsed).toBeLessThan(ms)` is fair on an idle machine and
 * flaky under a parallel suite: `pnpm test` runs the sdk lane beside six
 * DB-suite workers sharing one CPU, and a 200k-character guard input then
 * costs ~4x its idle time (measured: stripAnsi 334ms idle, 1476ms in a full
 * run) while behaving perfectly linearly. What these guards protect against
 * is the quadratic class — orders of magnitude, not a busy CPU — so the bound
 * compares the guarded call against a trivial linear reference measured
 * immediately before it under the same contention, and keeps the caller's
 * absolute ceiling as a floor. A quadratic regression is 1000x+ the
 * reference; the ratio rides through load spikes without giving that class
 * any room.
 */
const REFERENCE_ITERATIONS = 2_000_000;

/** Wall-clock ms of a plain linear loop — the load probe the bound rides on. */
function referenceMs(): number {
  const start = performance.now();
  let acc = 0;
  for (let i = 0; i < REFERENCE_ITERATIONS; i++) acc += i & 1;
  if (acc !== REFERENCE_ITERATIONS / 2) throw new Error('unreachable');
  return performance.now() - start;
}

/** Idle reference is ~4ms; 128x keeps every measured idle cost well inside
 * the bound while a quadratic blowup at these input sizes (minutes) cannot
 * hide under any contention this runner can produce. */
const RATIO = 128;

/** Runs `fn` and fails when it costs meaningfully more than linear time. */
export function assertLinear(fn: () => unknown, ms = 250): void {
  const reference = referenceMs();
  const start = performance.now();
  fn();
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(Math.max(ms, RATIO * reference));
}
