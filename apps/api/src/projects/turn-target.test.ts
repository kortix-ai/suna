// A TURN RECORD BELONGS TO ONE SESSION, NOT TO A BOX.
//
// `activeTurns` is written into session_sandboxes rows selected by the target.
// `{externalId}` matches every session on a cell sandbox: measured on dev
// 2026-09-09, two sessions held the byte-identical set of five `active` records
// including ones belonging to neither, so one session's unfinished turn blocked
// every other session on that box behind `turn_active`.
import { describe, expect, test } from 'bun:test';
import { turnTargetFor } from './turn-target';

describe('choosing the row a turn record is written into', () => {
  test('targets the SESSION when it is known', () => {
    expect(turnTargetFor('sess-1', 'sbx_1')).toEqual({ sessionId: 'sess-1' });
  });

  test('two sessions on one box target different rows — the whole point', () => {
    expect(turnTargetFor('a', 'sbx_1')).not.toEqual(turnTargetFor('b', 'sbx_1'));
  });

  test('falls back to the box when there is no session', () => {
    // An orphan box being reconciled still has to address something, and for a
    // box with one session the two targets select the same row.
    expect(turnTargetFor(null, 'sbx_1')).toEqual({ externalId: 'sbx_1' });
    expect(turnTargetFor(undefined, 'sbx_1')).toEqual({ externalId: 'sbx_1' });
    expect(turnTargetFor('', 'sbx_1')).toEqual({ externalId: 'sbx_1' });
    expect(turnTargetFor('   ', 'sbx_1')).toEqual({ externalId: 'sbx_1' });
  });
});
