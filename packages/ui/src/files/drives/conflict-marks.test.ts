import { describe, expect, test } from 'bun:test';

import { type ConflictMarks, readConflictMarks } from './conflict-marks';

const ME = { driveId: 'drv_1', subdir: '/Users/ana' };
const TEAM = { driveId: 'drv_1', subdir: '/Team' };
const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-04T09:00:00.000Z';

/** Feed reads in order; return what each one would toast. */
function toasts(reads: Array<Parameters<typeof readConflictMarks>[1]>): number[] {
  let marks: ConflictMarks = {};
  return reads.map((drives) => {
    const read = readConflictMarks(marks, drives);
    marks = read.marks;
    return read.fresh;
  });
}

describe('session conflict notice', () => {
  test('a new session announces nothing when its sandbox mounts a folder with old conflicts', () => {
    // First read before the mount, then the mount appears with 3 open conflicts.
    expect(toasts([[], [{ ...ME, openConflicts: 3, latestConflictAt: T1 }]])).toEqual([0, 0]);
  });

  test('a conflict detected while the session watches is announced once', () => {
    const before = { ...ME, openConflicts: 3, latestConflictAt: T1 };
    const after = { ...ME, openConflicts: 4, latestConflictAt: T2 };
    expect(toasts([[before], [after], [after]])).toEqual([0, 1, 0]);
  });

  test('a new conflict counts while an old one is resolved in the same interval', () => {
    expect(toasts([[{ ...ME, openConflicts: 2, latestConflictAt: T1 }], [{ ...ME, openConflicts: 2, latestConflictAt: T2 }]])).toEqual([0, 1]);
  });

  test('a folder that mounts again after a box restart does not announce its old conflicts', () => {
    const row = { ...ME, openConflicts: 3, latestConflictAt: T1 };
    expect(toasts([[row], [], [row]])).toEqual([0, 0, 0]);
  });

  test('a folder shared into the session later announces nothing for its old conflicts', () => {
    const me = { ...ME, openConflicts: 0, latestConflictAt: null };
    expect(toasts([[me], [me, { ...TEAM, openConflicts: 5, latestConflictAt: T1 }]])).toEqual([0, 0]);
  });

  test('resolving conflicts announces nothing', () => {
    expect(toasts([[{ ...ME, openConflicts: 3, latestConflictAt: T2 }], [{ ...ME, openConflicts: 1, latestConflictAt: T1 }]])).toEqual([0, 0]);
  });

  test('an API without latestConflictAt: a rise in a mounted folder\'s count, never its first read', () => {
    expect(toasts([[], [{ ...ME, openConflicts: 3 }], [{ ...ME, openConflicts: 5 }]])).toEqual([0, 0, 2]);
  });
});
