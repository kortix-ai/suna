import { describe, expect, test } from 'bun:test';

import {
  approveAllSafe,
  bulkSetStatus,
  countsBySegment,
  decideApprovalAction,
  filterItems,
  groupBySession,
  matchesQuery,
  rollupApprovalStatus,
  safePendingCount,
  sessionOptions,
  setStatus,
} from './review-reducer';
import {
  type ApprovalAction,
  type ReviewItem,
  type ReviewRisk,
  type ReviewStatus,
  isSafeRisk,
  segmentForStatus,
} from './types';

const act = (id: string, risk: ReviewRisk, decided?: 'approved' | 'denied'): ApprovalAction => ({
  id,
  title: id,
  connector: 'c',
  action: 'c.x',
  consequence: '',
  risk,
  icon: 'generic',
  argsPreview: [],
  policySource: '',
  decided,
});

const approval = (
  id: string,
  actions: ApprovalAction[],
  status: ReviewStatus = 'needs_you',
): ReviewItem => ({
  id,
  kind: 'approval',
  title: id,
  summary: '',
  risk: 'high',
  status,
  source: 'web',
  project: 'P',
  agent: 'A',
  actor: { name: 'A', initials: 'A' },
  createdAt: '2020-01-01T00:00:00Z',
  primaryAction: 'Review',
  detail: { actions },
});

const change = (id: string, status: ReviewStatus): ReviewItem => ({
  id,
  kind: 'change',
  title: id,
  summary: '',
  risk: 'low',
  status,
  source: 'web',
  project: 'P',
  agent: 'A',
  actor: { name: 'A', initials: 'A' },
  createdAt: '2020-01-01T00:00:00Z',
  primaryAction: 'Ship it',
  detail: {
    whatChanged: [],
    impact: '',
    verification: [],
    advanced: {
      headRef: '',
      baseRef: '',
      headSha: '',
      baseSha: '',
      additions: 0,
      deletions: 0,
      mergeMode: '',
      files: [],
    },
  },
});

describe('segmentForStatus', () => {
  test('maps statuses to the three inbox segments', () => {
    expect(segmentForStatus('needs_you')).toBe('needs_you');
    expect(segmentForStatus('waiting')).toBe('waiting');
    for (const s of ['approved', 'changes_requested', 'rejected', 'done', 'dismissed'] as const) {
      expect(segmentForStatus(s)).toBe('done');
    }
  });
});

describe('isSafeRisk', () => {
  test('none and low are safe; medium and high are not', () => {
    expect(isSafeRisk('none')).toBe(true);
    expect(isSafeRisk('low')).toBe(true);
    expect(isSafeRisk('medium')).toBe(false);
    expect(isSafeRisk('high')).toBe(false);
  });
});

describe('rollupApprovalStatus', () => {
  test('null while empty or any action is pending', () => {
    expect(rollupApprovalStatus([])).toBeNull();
    expect(rollupApprovalStatus([act('a', 'low')])).toBeNull();
    expect(rollupApprovalStatus([act('a', 'low', 'approved'), act('b', 'high')])).toBeNull();
  });
  test('approved when all decided and at least one approved', () => {
    expect(rollupApprovalStatus([act('a', 'low', 'approved')])).toBe('approved');
    expect(rollupApprovalStatus([act('a', 'low', 'approved'), act('b', 'high', 'denied')])).toBe(
      'approved',
    );
  });
  test('rejected when all decided and none approved', () => {
    expect(rollupApprovalStatus([act('a', 'low', 'denied'), act('b', 'high', 'denied')])).toBe(
      'rejected',
    );
  });
});

describe('setStatus', () => {
  test('updates only the target item and is immutable', () => {
    const items = [change('c1', 'needs_you'), change('c2', 'needs_you')];
    const next = setStatus(items, 'c1', 'approved');
    expect(next.find((i) => i.id === 'c1')?.status).toBe('approved');
    expect(next.find((i) => i.id === 'c2')?.status).toBe('needs_you');
    expect(items[0].status).toBe('needs_you'); // original untouched
  });
});

describe('decideApprovalAction', () => {
  test('records a decision without rolling up while others pend', () => {
    const items = [approval('ap', [act('x1', 'high'), act('x2', 'low')])];
    const next = decideApprovalAction(items, 'ap', 'x1', 'denied');
    const item = next[0];
    if (item.kind !== 'approval') throw new Error('kind');
    expect(item.detail.actions.find((a) => a.id === 'x1')?.decided).toBe('denied');
    expect(item.status).toBe('needs_you');
  });
  test('rolls up to approved once the last action is decided', () => {
    let items = [approval('ap', [act('x1', 'high'), act('x2', 'low')])];
    items = decideApprovalAction(items, 'ap', 'x1', 'denied');
    items = decideApprovalAction(items, 'ap', 'x2', 'approved');
    expect(items[0].status).toBe('approved');
  });
  test('rolls up to rejected when every action is denied', () => {
    let items = [approval('ap', [act('x1', 'high'), act('x2', 'low')])];
    items = decideApprovalAction(items, 'ap', 'x1', 'denied');
    items = decideApprovalAction(items, 'ap', 'x2', 'denied');
    expect(items[0].status).toBe('rejected');
  });
  test('leaves non-approval items and unrelated ids untouched', () => {
    const items = [change('c1', 'needs_you'), approval('ap', [act('x1', 'low')])];
    const next = decideApprovalAction(items, 'c1', 'x1', 'approved');
    expect(next).toEqual(items);
  });
  test('is immutable — original action stays pending', () => {
    const items = [approval('ap', [act('x1', 'low')])];
    decideApprovalAction(items, 'ap', 'x1', 'approved');
    const orig = items[0];
    if (orig.kind !== 'approval') throw new Error('kind');
    expect(orig.detail.actions[0].decided).toBeUndefined();
  });
});

describe('approveAllSafe', () => {
  test('approves only pending safe actions and leaves risky ones pending', () => {
    const items = [approval('ap', [act('s1', 'low'), act('s2', 'none'), act('r1', 'high')])];
    const item = approveAllSafe(items, 'ap')[0];
    if (item.kind !== 'approval') throw new Error('kind');
    const byId = Object.fromEntries(item.detail.actions.map((a) => [a.id, a.decided]));
    expect(byId.s1).toBe('approved');
    expect(byId.s2).toBe('approved');
    expect(byId.r1).toBeUndefined();
    expect(item.status).toBe('needs_you'); // risky one still pending
  });
  test('rolls up to approved when no risky action remains', () => {
    const items = [approval('ap', [act('s1', 'low'), act('s2', 'low')])];
    expect(approveAllSafe(items, 'ap')[0].status).toBe('approved');
  });
  test('does not overwrite an already-decided safe action', () => {
    const items = [approval('ap', [act('s1', 'low', 'denied'), act('s2', 'low')])];
    const item = approveAllSafe(items, 'ap')[0];
    if (item.kind !== 'approval') throw new Error('kind');
    expect(item.detail.actions.find((a) => a.id === 's1')?.decided).toBe('denied');
  });
});

describe('safePendingCount', () => {
  test('counts pending safe actions across approvals, ignoring the rest', () => {
    const items = [
      approval('ap1', [act('s1', 'low'), act('r1', 'high'), act('s2', 'none', 'approved')]),
      approval('ap2', [act('s3', 'low')]),
      change('c1', 'needs_you'),
    ];
    expect(safePendingCount(items)).toBe(2); // s1 + s3
  });
});

describe('countsBySegment', () => {
  test('tallies items into needs_you / waiting / done', () => {
    const items = [
      change('a', 'needs_you'),
      change('b', 'needs_you'),
      change('c', 'waiting'),
      change('d', 'approved'),
      change('e', 'rejected'),
    ];
    expect(countsBySegment(items)).toEqual({ needs_you: 2, waiting: 1, done: 2 });
  });
});

describe('filterItems', () => {
  test('filters by segment and kind', () => {
    const items = [
      change('c1', 'needs_you'),
      approval('a1', [act('x', 'low')], 'needs_you'),
      change('c2', 'done'),
    ];
    expect(filterItems(items, 'needs_you', 'all').map((i) => i.id)).toEqual(['c1', 'a1']);
    expect(filterItems(items, 'needs_you', 'change').map((i) => i.id)).toEqual(['c1']);
    expect(filterItems(items, 'done', 'all').map((i) => i.id)).toEqual(['c2']);
  });
  test('also narrows by the search query', () => {
    const items = [change('pricing-page', 'needs_you'), change('signup-form', 'needs_you')];
    expect(filterItems(items, 'needs_you', 'all', 'pricing').map((i) => i.id)).toEqual([
      'pricing-page',
    ]);
    expect(filterItems(items, 'needs_you', 'all', '   ').map((i) => i.id)).toEqual([
      'pricing-page',
      'signup-form',
    ]);
  });
});

describe('matchesQuery', () => {
  test('matches title, summary, project and agent case-insensitively; empty matches all', () => {
    const item = change('c1', 'needs_you'); // title 'c1', project 'P', agent 'A'
    expect(matchesQuery(item, '')).toBe(true);
    expect(matchesQuery(item, 'c1')).toBe(true);
    expect(matchesQuery(item, 'p')).toBe(true); // project P
    expect(matchesQuery(item, 'zzz')).toBe(false);
  });
});

describe('bulkSetStatus', () => {
  test('sets the status on every id in the set and leaves others alone', () => {
    const items = [change('a', 'needs_you'), change('b', 'needs_you'), change('c', 'needs_you')];
    const next = bulkSetStatus(items, ['a', 'c'], 'dismissed');
    expect(next.map((i) => i.status)).toEqual(['dismissed', 'needs_you', 'dismissed']);
    expect(items[0].status).toBe('needs_you'); // immutable
  });
  test('accepts a Set of ids', () => {
    const items = [change('a', 'needs_you'), change('b', 'needs_you')];
    const next = bulkSetStatus(items, new Set(['b']), 'approved');
    expect(next.find((i) => i.id === 'b')?.status).toBe('approved');
  });
});

// ── per-session grouping + filtering ────────────────────────────────────────
const sItem = (
  id: string,
  sessionId: string | undefined,
  createdAt: string,
  status: ReviewStatus = 'needs_you',
): ReviewItem => ({ ...change(id, status), sessionId, createdAt });

describe('per-session view', () => {
  const items = [
    sItem('a', 's1', '2020-01-03T00:00:00Z'),
    sItem('b', 's2', '2020-01-01T00:00:00Z'),
    sItem('c', 's1', '2020-01-02T00:00:00Z'),
    sItem('d', undefined, '2020-01-04T00:00:00Z'),
  ];
  const labelFor = (id: string): string | undefined => ({ s1: 'Fix login', s2: 'Refactor' })[id];

  test('filterItems narrows to a single session', () => {
    const v = filterItems(items, 'needs_you', 'all', '', 's1');
    expect(v.map((i) => i.id).sort()).toEqual(['a', 'c']);
  });

  test("filterItems 'all' keeps every session (incl. no-session items)", () => {
    expect(filterItems(items, 'needs_you', 'all', '', 'all')).toHaveLength(4);
  });

  test('groupBySession buckets by session, newest-activity first, No session last', () => {
    const g = groupBySession(items, labelFor);
    expect(g.map((x) => x.sessionId)).toEqual(['s1', 's2', null]);
    expect(g[0]!.label).toBe('Fix login');
    expect(g[0]!.items.map((i) => i.id).sort()).toEqual(['a', 'c']);
    expect(g[2]!.label).toBe('No session');
  });

  test('groupBySession falls back to a short id when unlabeled', () => {
    const g = groupBySession(
      [sItem('x', 'abcdef1234567', '2020-01-01T00:00:00Z')],
      () => undefined,
    );
    expect(g[0]!.label).toBe('Session abcdef12');
  });

  test('sessionOptions lists distinct labeled sessions, excludes No session', () => {
    const opts = sessionOptions(items, labelFor);
    expect(opts.map((o) => o.sessionId)).toEqual(['s1', 's2']);
    expect(opts.map((o) => o.label)).toEqual(['Fix login', 'Refactor']);
  });
});
