import { describe, expect, test } from 'bun:test';
import { humanStageMoveAllowed } from './session-stage';
import { STAGE_INSTRUCTIONS, monitoringStageInstructionsEnv } from './session-stage-instructions';

describe('monitoringStageInstructionsEnv', () => {
  test('flag on → env carries the protocol; off → nothing', () => {
    const on = monitoringStageInstructionsEnv({ experimental: { monitoring: true } });
    expect(on.KORTIX_STAGE_INSTRUCTIONS).toBe(STAGE_INSTRUCTIONS);
    expect(STAGE_INSTRUCTIONS).toContain('kortix sessions stage');
    expect(STAGE_INSTRUCTIONS.length).toBeLessThanOrEqual(1500);
    expect(monitoringStageInstructionsEnv({ experimental: { monitoring: false } })).toEqual({});
    expect(monitoringStageInstructionsEnv({})).toEqual({});
    expect(monitoringStageInstructionsEnv(null)).toEqual({});
  });
});

describe('humanStageMoveAllowed', () => {
  const waiting = {
    value: 'ready',
    needs_approval: true,
    note: null,
    updated_at: '',
    updated_by: 'agent',
  } as const;
  test('only approve / send back of a card awaiting approval', () => {
    expect(humanStageMoveAllowed(waiting, 'in_progress')).toBe(true);
    expect(humanStageMoveAllowed(waiting, 'planning')).toBe(true);
    expect(humanStageMoveAllowed(waiting, 'done')).toBe(false);
    expect(humanStageMoveAllowed({ ...waiting, needs_approval: false }, 'in_progress')).toBe(false);
    expect(humanStageMoveAllowed({ ...waiting, value: 'review' }, 'in_progress')).toBe(false);
    expect(humanStageMoveAllowed(null, 'ready')).toBe(false);
  });
});
