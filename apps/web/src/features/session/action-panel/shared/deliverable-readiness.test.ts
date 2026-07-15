import { describe, expect, test } from 'bun:test';
import { chipForCompletion } from './deliverable-readiness';

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
