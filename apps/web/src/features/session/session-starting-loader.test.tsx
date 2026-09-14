import { describe, expect, test } from 'bun:test';

import { STEPS, activeStep } from './session-starting-loader';

const STARTING_SUBSTEP_ELAPSED = 5_000;

describe('STEPS copy', () => {
  test('every stage has its own label', () => {
    expect(new Set(STEPS.map((step) => step.label)).size).toBe(STEPS.length);
  });

  test('covers every step activeStep can resolve to', () => {
    const reachable = ['provisioning', 'starting', 'ready'] as const;
    const indices = new Set([
      ...reachable.map((stage) => activeStep(stage, 0)),
      activeStep('starting', STARTING_SUBSTEP_ELAPSED),
    ]);
    expect(indices).toEqual(new Set([0, 1, 2, 3]));
    for (const index of indices) expect(STEPS[index]).toBeDefined();
  });
});

describe('activeStep', () => {
  test('maps each backend stage to the step it is really on', () => {
    expect(activeStep('provisioning', 0)).toBe(0);
    expect(activeStep('starting', 0)).toBe(1);
    expect(activeStep('ready', 0)).toBe(3);
  });

  test('soft-advances within the `starting` stage once the clone should be done', () => {
    expect(activeStep('starting', 4_999)).toBe(1);
    expect(activeStep('starting', 5_000)).toBe(2);
    expect(activeStep('starting', 60_000)).toBe(2);
  });
});
