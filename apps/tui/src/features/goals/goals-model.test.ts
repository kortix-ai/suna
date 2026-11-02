import { describe, expect, test } from 'bun:test';

import type { ProjectGoal } from '@kortix/sdk';

import {
  detailLines,
  goalGroup,
  tailLines,
  toGoalDetail,
  toGoalRow,
  webGoalUrl,
  wrap,
} from './goals-model.ts';

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();

function goal(
  overrides: Partial<ProjectGoal> & { doc?: Partial<NonNullable<ProjectGoal['goal']>> } = {},
): ProjectGoal {
  const { doc, ...rest } = overrides;
  return {
    slug: 'bank-close',
    scope: 'company',
    driveId: 'drive-1',
    folder: '/Company/Goals/bank-close',
    goal: {
      version: 1,
      objective: 'Close the books by Friday',
      status: 'active',
      summary: 'Reconciling accounts.',
      success_criteria: [
        { id: 'c1', text: 'All accounts reconciled', met: true, evidence: 'evidence/rec.md' },
        { id: 'c2', text: 'Sign-off recorded', met: false, evidence: null },
      ],
      items: [],
      sessions: [
        { id: 'sess-old', role: 'owner', since: '2026-09-15T00:00:00Z' },
        { id: 'sess-new', role: 'owner', since: '2026-09-16T00:00:00Z' },
      ],
      reminder_id: null,
      transitions: [],
      verified_by: null,
      next_wake_at: null,
      agent: 'finance',
      ...doc,
    },
    heartbeat: null,
    coordinatorSessionId: 'sess-new',
    health: { state: 'healthy', issues: [] },
    ...rest,
  } as ProjectGoal;
}

describe('goalGroup', () => {
  test('a healthy open goal is open', () => {
    expect(goalGroup(goal())).toBe('open');
  });

  test('waiting_on_user or an open ask for a person needs you', () => {
    expect(goalGroup(goal({ doc: { status: 'waiting_on_user' } }))).toBe('needs_you');
    const ask = goal({
      doc: {
        items: [
          { id: 'i1', kind: 'ask', title: 'Pick a bank', status: 'open', owner: 'user', due: null },
        ],
      },
    });
    expect(goalGroup(ask)).toBe('needs_you');
  });

  test('an ask owned by the agent does not need you', () => {
    const ask = goal({
      doc: {
        items: [{ id: 'i1', kind: 'ask', title: 'x', status: 'open', owner: 'agent', due: null }],
      },
    });
    expect(goalGroup(ask)).toBe('open');
  });

  test('a health issue without a question needs attention; closed wins over both', () => {
    const sick = goal({ health: { state: 'attention', issues: ['no_heartbeat'] } });
    expect(goalGroup(sick)).toBe('attention');
    const closed = goal({ health: { state: 'closed', issues: [] }, doc: { status: 'done' } });
    expect(goalGroup(closed)).toBe('closed');
  });
});

describe('toGoalRow', () => {
  test('carries title, progress, status and the first issue as the line', () => {
    const row = toGoalRow(goal({ health: { state: 'attention', issues: ['missed_wake'] } }));
    expect(row).toMatchObject({
      id: 'company/bank-close',
      title: 'Close the books by Friday',
      progress: '1/2',
      status: 'Active',
      glyph: '!',
      line: 'The next wake is overdue.',
      agent: 'finance',
    });
  });

  test('a goal with no GOAL.md falls back to the slug and says unreadable', () => {
    const row = toGoalRow(
      goal({ goal: null, health: { state: 'attention', issues: ['unreadable'] } }),
    );
    expect(row.title).toBe('bank-close');
    expect(row.status).toBe('Unreadable');
    expect(row.progress).toBe('');
  });
});

describe('toGoalDetail', () => {
  const files = { loading: false, verification: null, log: null };

  test('lists the newest owner session first and allows reply and stop on an open goal', () => {
    const detail = toGoalDetail(goal(), files);
    expect(detail.sessions.map((s) => s.id)).toEqual(['sess-new', 'sess-old']);
    expect(detail.canReply).toBe(true);
    expect(detail.canStop).toBe(true);
  });

  test('a closed goal can be neither answered nor stopped', () => {
    const detail = toGoalDetail(
      goal({ health: { state: 'closed', issues: [] }, doc: { status: 'done' } }),
      files,
    );
    expect([detail.canReply, detail.canStop]).toEqual([false, false]);
  });

  test('a legacy goal.json folder cannot be stopped (stopProjectGoal throws)', () => {
    expect(toGoalDetail(goal({ doc: { format: 'goal.json' } }), files).canStop).toBe(false);
  });

  test('no owner session means no reply', () => {
    expect(toGoalDetail(goal({ coordinatorSessionId: null }), files).canReply).toBe(false);
  });
});

describe('detailLines', () => {
  test('prints criteria with marks, sessions as selectable lines, and the log tail', () => {
    const detail = toGoalDetail(goal({ heartbeat: null }), {
      loading: false,
      verification: '# Verdict\nAll good.',
      log: '# Log\n- one\n- two',
    });
    const lines = detailLines(detail, 60, NOW);
    const text = lines.map((l) => l.text);
    expect(text).toContain('[x] All accounts reconciled');
    expect(text).toContain('[ ] Sign-off recorded');
    expect(text).toContain('Done when · 1/2');
    expect(text.some((t) => t.startsWith('owner    sess-new'))).toBe(true);
    expect(lines.filter((l) => l.sessionId).map((l) => l.sessionId)).toEqual([
      'sess-new',
      'sess-old',
    ]);
    expect(text).toContain('Verification');
    expect(text).toContain('- two');
  });

  test('wraps a long title to the width', () => {
    const detail = toGoalDetail(goal({ doc: { objective: 'word '.repeat(30).trim() } }), {
      loading: false,
      verification: null,
      log: null,
    });
    for (const line of detailLines(detail, 30, NOW))
      expect(line.text.length).toBeLessThanOrEqual(34);
  });
});

describe('helpers', () => {
  test('wrap breaks on words and hard-splits an over-long word', () => {
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
    expect(wrap('x'.repeat(20), 8)).toEqual(['xxxxxxxx', 'xxxxxxxx', 'xxxx']);
    expect(wrap('', 10)).toEqual(['']);
  });

  test('tailLines drops blank lines and keeps the last N', () => {
    expect(tailLines('a\n\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(tailLines(null, 2)).toEqual([]);
  });

  test('webGoalUrl joins origin, project, scope and an encoded slug', () => {
    expect(webGoalUrl('https://dev.kortix.com/', 'p1', { scope: 'company', slug: 'a b' })).toBe(
      'https://dev.kortix.com/projects/p1/goals/company/a%20b',
    );
  });
});
