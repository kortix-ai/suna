import { describe, expect, test } from 'bun:test';

import { needsYouBySession, needsYouReason, type NeedsYouItem } from './needs-you';

function item(overrides: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    status: 'needs_you',
    kind: 'approval',
    title: '(Gmail) Send Email',
    sessionId: 'session-a',
    createdAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('needsYouReason', () => {
  test('names the wait by kind', () => {
    expect(needsYouReason(item({ kind: 'approval', title: '(Gmail) Send Email' }))).toBe(
      'Approve: (Gmail) Send Email'
    );
    expect(needsYouReason(item({ kind: 'change', title: 'Add pricing page' }))).toBe(
      'Change request: Add pricing page'
    );
    expect(needsYouReason(item({ kind: 'decision', title: 'Keep 3 tiers or 4?' }))).toBe(
      'Asked: Keep 3 tiers or 4?'
    );
    expect(needsYouReason(item({ kind: 'output', title: 'Launch post draft' }))).toBe(
      'Review: Launch post draft'
    );
    expect(needsYouReason(item({ kind: 'batch', title: '4 edits' }))).toBe('Review: 4 edits');
  });

  test('a blank title falls back to the kind alone', () => {
    expect(needsYouReason(item({ kind: 'approval', title: '  ' }))).toBe('Waiting for your approval');
    expect(needsYouReason(item({ kind: 'decision', title: '' }))).toBe('Waiting for your answer');
  });
});

describe('needsYouBySession', () => {
  test('counts only needs_you items with a session', () => {
    const result = needsYouBySession([
      item({ sessionId: 'session-a' }),
      item({ sessionId: 'session-a', status: 'waiting' }),
      item({ sessionId: 'session-a', status: 'done' }),
      item({ sessionId: undefined }),
      item({ sessionId: 'session-b', kind: 'decision', title: 'Keep 3 tiers or 4?' }),
    ]);
    expect([...result.keys()].sort()).toEqual(['session-a', 'session-b']);
    expect(result.get('session-a')?.count).toBe(1);
    expect(result.get('session-b')?.reason).toBe('Asked: Keep 3 tiers or 4?');
  });

  test('the reason is the newest item, with the rest counted', () => {
    const result = needsYouBySession([
      item({ title: 'Old', createdAt: '2026-09-24T09:00:00.000Z' }),
      item({ title: 'New', createdAt: '2026-09-24T11:00:00.000Z' }),
      item({ title: 'Middle', createdAt: '2026-09-24T10:00:00.000Z' }),
    ]);
    const entry = result.get('session-a');
    expect(entry?.count).toBe(3);
    expect(entry?.reason).toBe('Approve: New · 2 more');
    expect(entry?.newestAt).toBe(Date.parse('2026-09-24T11:00:00.000Z'));
  });

  test('an unparseable timestamp sorts as oldest, never throws', () => {
    const result = needsYouBySession([
      item({ title: 'Bad date', createdAt: 'not a date' }),
      item({ title: 'Good', createdAt: '2026-09-24T11:00:00.000Z' }),
    ]);
    expect(result.get('session-a')?.reason).toBe('Approve: Good · 1 more');
  });

  test('no items → an empty map', () => {
    expect(needsYouBySession([]).size).toBe(0);
  });
});

// KRTX-1739: GET needs-input lists open agent questions (and connector
// approvals) per session; a session blocked on a question reads Needs you.
describe('needsYouBySession with the needs-input summary', () => {
  test('a session only needs-input lists waits for an answer', () => {
    const result = needsYouBySession([], { total: 1, sessions: { 'session-q': 1 } });
    expect(result.get('session-q')).toEqual({ count: 1, reason: 'Waiting for your answer', newestAt: 0 });
  });

  test('a session in both keeps its inbox reason and takes the larger count', () => {
    // One connector approval (in both lists) and one open question: needs-input says 2.
    const result = needsYouBySession([item({ title: '(Gmail) Send Email' })], {
      total: 2,
      sessions: { 'session-a': 2 },
    });
    expect(result.get('session-a')).toMatchObject({ count: 2, reason: 'Approve: (Gmail) Send Email · 1 more' });
  });

  test('a smaller needs-input count never lowers the inbox count', () => {
    const result = needsYouBySession([item({ title: 'A' }), item({ title: 'B' })], {
      total: 1,
      sessions: { 'session-a': 1 },
    });
    expect(result.get('session-a')?.count).toBe(2);
  });

  test('no summary, or an empty one, changes nothing', () => {
    expect(needsYouBySession([item()], undefined).get('session-a')?.count).toBe(1);
    expect(needsYouBySession([], { total: 0, sessions: {} }).size).toBe(0);
  });
});
