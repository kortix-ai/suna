import { describe, expect, test } from 'bun:test';
import {
  chipForCompletion,
  completionYieldsToPendingInput,
  pendingInputCount,
} from './deliverable-readiness';

describe('chipForCompletion', () => {
  test('successful run with deliverables → ready chip carrying the primary name', () => {
    expect(chipForCompletion('succeeded', 3, 'Quarterly report', 's1')).toEqual({
      sessionId: 's1',
      outcome: 'ready',
      count: 3,
      primaryName: 'Quarterly report',
    });
  });

  test('successful run with NOTHING produced → no chip (nothing to announce)', () => {
    expect(chipForCompletion('succeeded', 0, undefined, 's1')).toBeNull();
  });

  test('failed and stopped runs chip regardless of deliverables — the outcome IS the news', () => {
    expect(chipForCompletion('failed', 0, undefined, 's1')?.outcome).toBe('failed');
    expect(chipForCompletion('stopped', 2, 'draft.md', 's1')?.outcome).toBe('stopped');
  });
});

describe('completionYieldsToPendingInput', () => {
  test('an outstanding question/permission outranks run completion — no ready chip may clobber it', () => {
    expect(completionYieldsToPendingInput(1)).toBe(true);
    expect(completionYieldsToPendingInput(3)).toBe(true);
  });

  test('nothing pending → completion announces normally', () => {
    expect(completionYieldsToPendingInput(0)).toBe(false);
  });
});

describe('pendingInputCount', () => {
  test('counts only the permissions and questions belonging to THIS session', () => {
    const permissions = {
      p1: { sessionID: 's1' },
      p2: { sessionID: 's2' },
    };
    const questions = {
      q1: { sessionID: 's1' },
      q2: { sessionID: 's1' },
      q3: { sessionID: 's2' },
    };
    expect(pendingInputCount(permissions, questions, 's1')).toBe(3);
    expect(pendingInputCount(permissions, questions, 's2')).toBe(2);
  });

  test('nothing pending for a session that has no matching records', () => {
    const permissions = { p1: { sessionID: 's1' } };
    const questions = { q1: { sessionID: 's1' } };
    expect(pendingInputCount(permissions, questions, 's3')).toBe(0);
  });
});
