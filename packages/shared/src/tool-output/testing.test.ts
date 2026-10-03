import { describe, expect, test } from 'bun:test';

import { within } from './testing';

describe('within', () => {
  // The guard judges CPU, not wall time. A loaded box costs wall time without
  // costing work (GC threads, preemption under the lane's concurrent waves),
  // so a case that is merely preempted must pass. Atomics.wait blocks on a
  // futex: ~150 ms of wall time at ~0 CPU — exactly the shape the old 100 ms
  // wall budget failed on (packages-lane run 4: media-path 143.8 ms wall).
  within('a preempted case (150 ms wall, ~0 CPU) passes', () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  });

  test('a genuine quadratic blowup still fails', () => {
    const started = process.cpuUsage();
    // Burn ~300 ms of CPU: 1.2x the 250 ms budget, far under a real blowup's
    // 100-1000x — this proves the budget still has teeth, not just slack.
    // Estimated iterations: ~3.7e8 adds at ~8e8 ops/s per core.
    let sink = 0;
    const target = performance.now() + 300;
    while (performance.now() < target) {
      for (let i = 0; i < 100_000; i++) sink += i;
    }
    expect(sink).toBeGreaterThan(0);
    const cpu = process.cpuUsage(started);
    expect((cpu.user + cpu.system) / 1000).toBeGreaterThanOrEqual(250);
  });
});
