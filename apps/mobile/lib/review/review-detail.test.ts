import { describe, expect, test } from 'bun:test';
import type { ReviewItem } from '@kortix/sdk';

import { changeRequestWebUrl, reviewDetailRows, shortRef, splitFilePath } from './review-detail';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

function change(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'cr:abc',
    kind: 'change',
    status: 'needs_you',
    risk: 'medium',
    title: 'Add login',
    agent: '',
    createdAt: '2026-09-27T09:00:00.000Z',
    sessionId: 'ps-1',
    detail: {
      crId: 'abc',
      number: 8,
      whatChanged: [],
      impact: '',
      verification: [],
      advanced: {
        headRef: 'feat/login',
        baseRef: 'main',
        headSha: '',
        baseSha: '',
        additions: 0,
        deletions: 0,
        files: [],
        mergeMode: 'merge',
      },
    },
    ...over,
  } as ReviewItem;
}

const value = (rows: { label: string; value: string }[], label: string) =>
  rows.find((row) => row.label === label)?.value;

describe('reviewDetailRows', () => {
  test('a change request: number, branch, size, merge state, age', () => {
    const rows = reviewDetailRows(change(), {
      now: NOW,
      diff: { additions: 120, deletions: 30, files_changed: 4 },
      preview: { can_merge: true, conflicts: [], is_up_to_date: false },
    });
    expect(rows.map((row) => row.label)).toEqual(['Change request', 'Branch', 'Changes', 'Merge', 'Opened']);
    expect(value(rows, 'Change request')).toBe('#8');
    expect(value(rows, 'Branch')).toBe('feat/login → main');
    expect(value(rows, 'Changes')).toBe('+120 −30 · 4 files');
    expect(value(rows, 'Merge')).toBe('Ready to merge');
    expect(value(rows, 'Opened')).toBe('3h ago');
  });

  test('merge state names conflicts and a change already in base', () => {
    const conflicted = reviewDetailRows(change(), {
      now: NOW,
      preview: { can_merge: false, conflicts: ['a.ts', 'b.ts'], is_up_to_date: false },
    });
    expect(value(conflicted, 'Merge')).toBe('Conflicts in 2 files');
    const upToDate = reviewDetailRows(change(), {
      now: NOW,
      preview: { can_merge: true, conflicts: [], is_up_to_date: true },
    });
    expect(value(upToDate, 'Merge')).toBe('Already in main');
  });

  test('a change request hides the placeholder risk and an empty agent; loading rows are left out', () => {
    const rows = reviewDetailRows(change(), { now: NOW });
    expect(rows.map((row) => row.label)).toEqual(['Change request', 'Branch', 'Opened']);
    expect(rows.find((row) => row.label === 'Risk')).toBeUndefined();
    expect(rows.find((row) => row.label === 'Agent')).toBeUndefined();
  });

  test('a merged change request says so instead of a merge state', () => {
    const rows = reviewDetailRows(change({ status: 'approved' }), {
      now: NOW,
      preview: { can_merge: false, conflicts: ['x'], is_up_to_date: false },
    });
    expect(value(rows, 'Merge')).toBe('Merged');
  });

  test('another kind: agent and risk', () => {
    const rows = reviewDetailRows(
      { ...change(), kind: 'approval', agent: 'kortix', risk: 'high' } as ReviewItem,
      { now: NOW },
    );
    expect(rows.map((row) => row.label)).toEqual(['Agent', 'Risk', 'Opened']);
    expect(value(rows, 'Agent')).toBe('kortix');
    expect(value(rows, 'Risk')).toBe('High');
    const low = reviewDetailRows({ ...change(), kind: 'output', agent: 'kortix', risk: 'none' } as ReviewItem, { now: NOW });
    expect(value(low, 'Risk')).toBeUndefined();
  });
});

describe('changeRequestWebUrl', () => {
  test('the session page with ?cr= when the session is known, else the review page', () => {
    expect(changeRequestWebUrl('p1', change())).toBe('https://kortix.com/projects/p1/sessions/ps-1?cr=abc');
    expect(changeRequestWebUrl('p1', change({ sessionId: undefined }))).toBe('https://kortix.com/projects/p1/customize/review');
  });
});

describe('splitFilePath', () => {
  test('name and folder', () => {
    expect(splitFilePath('src/app/login.tsx')).toEqual({ name: 'login.tsx', dir: 'src/app' });
    expect(splitFilePath('README.md')).toEqual({ name: 'README.md', dir: '' });
  });
});

describe('shortRef', () => {
  test('a UUID branch shows 8 characters; a name stays', () => {
    expect(shortRef('0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b')).toBe('0f8a1b2c');
    expect(shortRef('feat/login')).toBe('feat/login');
  });
});
