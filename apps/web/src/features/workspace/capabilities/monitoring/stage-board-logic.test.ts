import type { ProjectSession } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { groupSessionsByStage, needsApproval, sessionStage } from './stage-board-logic';

const session = (
  id: string,
  stage: Partial<NonNullable<ProjectSession['stage']>> | null,
  updated_at = '2026-09-04T10:00:00.000Z',
): ProjectSession =>
  ({
    session_id: id,
    updated_at,
    stage: stage
      ? {
          value: 'backlog',
          needs_approval: false,
          note: null,
          updated_at,
          updated_by: 'agent',
          ...stage,
        }
      : null,
  }) as unknown as ProjectSession;

describe('groupSessionsByStage', () => {
  test('every column exists; unstaged and unknown stages land in backlog', () => {
    const groups = groupSessionsByStage([
      session('a', null),
      session('b', { value: 'wat' as never }),
      session('c', { value: 'review' }),
    ]);
    expect(Object.keys(groups)).toEqual([
      'backlog',
      'planning',
      'ready',
      'in_progress',
      'review',
      'done',
    ]);
    expect(groups.backlog.map((s) => s.session_id)).toEqual(['a', 'b']);
    expect(groups.review.map((s) => s.session_id)).toEqual(['c']);
    expect(groups.done).toEqual([]);
  });

  test('a column is newest move first; the stage stamp outranks updated_at', () => {
    const groups = groupSessionsByStage([
      session(
        'old',
        { value: 'ready', updated_at: '2026-09-01T00:00:00.000Z' },
        '2026-09-05T00:00:00.000Z',
      ),
      session(
        'new',
        { value: 'ready', updated_at: '2026-09-03T00:00:00.000Z' },
        '2026-09-02T00:00:00.000Z',
      ),
      session('unstamped', null, '2026-09-04T00:00:00.000Z'),
    ]);
    expect(groups.ready.map((s) => s.session_id)).toEqual(['new', 'old']);
    expect(groups.backlog.map((s) => s.session_id)).toEqual(['unstamped']);
  });
});

describe('needsApproval', () => {
  test('only a Ready card with the flag', () => {
    expect(needsApproval(session('a', { value: 'ready', needs_approval: true }))).toBe(true);
    expect(needsApproval(session('a', { value: 'ready' }))).toBe(false);
    expect(needsApproval(session('a', { value: 'in_progress', needs_approval: true }))).toBe(false);
    expect(sessionStage(session('a', null))).toBe('backlog');
  });
});
