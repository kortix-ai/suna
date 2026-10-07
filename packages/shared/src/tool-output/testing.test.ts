import { describe, expect, test } from 'bun:test';

import { cpuCostOf, within } from './testing';

describe('within', () => {
  // The guard judges CPU, not wall time. A loaded box costs wall time without
  // costing work (GC threads, preemption under the lane's concurrent waves),
  // so a case that is merely preempted must pass. Atomics.wait blocks on a
  // futex: ~150 ms of wall time at ~0 CPU — exactly the shape the old 100 ms
  // wall budget failed on (packages-lane run 4: media-path 143.8 ms wall).
  within('a preempted case (150 ms wall, ~0 CPU) passes', () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  });

  test('a genuine quadratic blowup measures over budget', () => {
    // Burn 300 ms of CPU — bounded by the CPU clock, not the wall clock, so
    // the burn is guaranteed even when the box preempts this process (a
    // wall-bounded loop measures LESS CPU than wall under the lane's load).
    // 300 ms is 1.2x the 250 ms budget and far under a real blowup's
    // 100-1000x: measured over budget means within() fails it.
    const burn = () => {
      let sink = 0;
      const started = process.cpuUsage();
      for (;;) {
        for (let i = 0; i < 10_000; i++) sink += i;
        const used = process.cpuUsage(started);
        if ((used.user + used.system) / 1000 >= 300) break;
      }
      return sink;
    };
    expect(cpuCostOf(burn)).toBeGreaterThanOrEqual(250);
  });
});
