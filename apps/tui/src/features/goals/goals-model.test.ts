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
    goalId: 'g-1',
    revision: 3,
    capabilities: { read: true, edit: true, pause: true, resume: false, stop: true, restart: false, answer: true, edit_criteria: true },
    blockedReason: null,
    verification: null,
    criteria: [
      { id: 'c1', text: 'All accounts reconciled', reported_met: true, evidence: 'evidence/rec.md', verified: true },
      { id: 'c2', text: 'Sign-off recorded', reported_met: true, evidence: null, verified: false },
      { id: 'c3', text: 'Filed', reported_met: false, evidence: null, verified: false },
    ],
    record: { wakes_today: 3, max_wakes_per_day: 12, paused_at: null, waiting_on: null, next_wake_at: null },
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
      id: 'g-1',
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

  test('lists the newest owner session first; the controls are the capabilities the API returned', () => {
    const detail = toGoalDetail(goal(), files);
    expect(detail.sessions.map((s) => s.id)).toEqual(['sess-new', 'sess-old']);
    expect([detail.canReply, detail.canStop, detail.canPause, detail.canResume, detail.canRestart]).toEqual([true, true, true, false, false]);
  });

  test('a read-only viewer gets no control at all', () => {
    const none = { read: true, edit: false, pause: false, resume: false, stop: false, restart: false, answer: false, edit_criteria: false };
    const detail = toGoalDetail(goal({ capabilities: none }), files);
    expect([detail.canReply, detail.canStop, detail.canPause, detail.canResume, detail.canRestart]).toEqual([false, false, false, false, false]);
  });

  test('a blocked goal says why and what to do next', () => {
    const detail = toGoalDetail(goal({ blockedReason: 'credits', health: { state: 'attention', issues: ['blocked'] } }), files);
    expect(detail.issues).toEqual(['Out of credits: no wake can start. Add credits, then resume it (p).']);
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
    // [x] verified by the independent check, [~] only reported met by the agent, [ ] open.
    expect(text).toContain('[x] All accounts reconciled');
    expect(text).toContain('[~] Sign-off recorded');
    expect(text).toContain('[ ] Filed');
    expect(text).toContain('Done when · 1/3 verified · 2 reported');
    expect(text).toContain('3/12 wakes today');
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

  test('webGoalUrl opens the goal by its id; without one, the legacy scope/slug link', () => {
    expect(webGoalUrl('https://dev.kortix.com/', 'p1', { goalId: 'g 1', scope: 'company', slug: 'a b' })).toBe(
      'https://dev.kortix.com/workspaces/p1/goals/g%201',
    );
    expect(webGoalUrl('https://dev.kortix.com/', 'p1', { scope: 'company', slug: 'a b' })).toBe(
      'https://dev.kortix.com/workspaces/p1/goals/company/a%20b',
    );
  });
});
