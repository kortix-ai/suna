import { describe, expect, test } from 'bun:test';

import { STEPS, activeStep, bootProgressPct } from './session-starting-loader';

/** Past the `starting` soft-advance threshold, to reach step 2. */
const STARTING_SUBSTEP_ELAPSED = 5_000;

describe('STEPS copy', () => {
  test('every stage has its own title and its own description', () => {
    // The compact variant shows ONE step at a time, so a repeated title or
    // description would make the boot look frozen even while it advances.
    expect(new Set(STEPS.map((s) => s.label)).size).toBe(STEPS.length);
    expect(new Set(STEPS.map((s) => s.description)).size).toBe(STEPS.length);
  });

  test('covers every step activeStep can resolve to', () => {
    const reachable = ['provisioning', 'starting', 'ready'] as const;
    const indices = new Set([
      ...reachable.map((stage) => activeStep(stage, 0)),
      activeStep('starting', STARTING_SUBSTEP_ELAPSED),
    ]);
    expect(indices).toEqual(new Set([0, 1, 2, 3]));
    for (const i of indices) expect(STEPS[i]).toBeDefined();
  });
});

describe('activeStep', () => {
  test('maps each backend stage to the step it is really on', () => {
    expect(activeStep('provisioning', 0)).toBe(0);
    expect(activeStep('starting', 0)).toBe(1);
    expect(activeStep('ready', 0)).toBe(3);
  });

  test('soft-advances within the `starting` stage once the clone should be done', () => {
    // Clone → OpenCode boot both happen inside the one backend `starting`
    // stage, so the advance is time-based rather than server-driven.
    expect(activeStep('starting', 4_999)).toBe(1);
    expect(activeStep('starting', 5_000)).toBe(2);
    expect(activeStep('starting', 60_000)).toBe(2);
  });
});

describe('bootProgressPct', () => {
  test('advances monotonically as the boot moves through its steps', () => {
    const values = [0, 1, 2, 3].map(bootProgressPct);
    expect(values).toEqual([12.5, 37.5, 62.5, 87.5]);
  });

  test('never reads as 0% (dead on arrival) or 100% (a lie while still connecting)', () => {
    // The rail sits at the MIDPOINT of the active step on purpose: there is no
    // sub-step telemetry, so both endpoints would be claims we cannot back.
    for (const active of [0, 1, 2, 3]) {
      expect(bootProgressPct(active)).toBeGreaterThan(0);
      expect(bootProgressPct(active)).toBeLessThan(100);
    }
  });

  test('clamps past the last step instead of overrunning the rail', () => {
    expect(bootProgressPct(99)).toBe(bootProgressPct(3));
  });
});
