import { describe, expect, test } from 'bun:test';
import { findGoalHeartbeat } from './goal-wake';

const loop = (prompt: string, over: { enabled?: boolean; nextFireAt?: Date | null } = {}) => ({
  enabled: over.enabled ?? true,
  nextFireAt: over.nextFireAt === undefined ? new Date('2026-10-28T12:00:00Z') : over.nextFireAt,
  scheduleSpec: { promptTemplate: prompt } as never,
});
const folder = '/drives/company/Goals/eu-billing';

describe('findGoalHeartbeat', () => {
  test('finds the enabled loop that names exactly this goal folder', () => {
    const rows = [
      loop('Goal wake: /drives/company/Goals/eu-billing-v2. Load the kortix-goals skill and run one wake.'),
      loop(`Goal wake: ${folder}. Load the kortix-goals skill and run one wake.`, { enabled: false }),
      loop(`Goal wake: ${folder}. Load the kortix-goals skill and run one wake.`),
    ];
    expect(findGoalHeartbeat(rows, folder)).toBe(rows[2]!);
  });

  test('a paused, finished or unrelated loop is no heartbeat', () => {
    expect(findGoalHeartbeat([loop(`Goal wake: ${folder}. x`, { nextFireAt: null }), loop('Check the inbox')], folder)).toBeNull();
  });
});
