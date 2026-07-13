import { describe, expect, test } from 'bun:test';

import type { ApiReviewItem } from '@kortix/sdk/projects-client';

import { summarizeReviewSessions } from './use-review-session-summary';

function makeItem(overrides: Partial<ApiReviewItem> = {}): ApiReviewItem {
  return {
    review_item_id: 'ri1',
    account_id: 'a1',
    project_id: 'p1',
    origin_session_id: 's1',
    kind: 'output',
    status: 'needs_you',
    risk: 'none',
    source: 'agent',
    title: 'Output',
    summary: '',
    detail: {},
    agent: '',
    created_by: 'u1',
    acted_by: null,
    acted_at: null,
    feedback: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('summarizeReviewSessions', () => {
  test('empty list → zero total, no sessions', () => {
    expect(summarizeReviewSessions([])).toEqual({ totalNeedsYou: 0, needsYouBySession: {} });
  });

  test('counts only needs_you items', () => {
    const summary = summarizeReviewSessions([
      makeItem({ review_item_id: 'a', status: 'needs_you' }),
      makeItem({ review_item_id: 'b', status: 'approved' }),
      makeItem({ review_item_id: 'c', status: 'waiting' }),
      makeItem({ review_item_id: 'd', status: 'needs_you' }),
    ]);
    expect(summary.totalNeedsYou).toBe(2);
  });

  test('groups needs_you by origin session', () => {
    const summary = summarizeReviewSessions([
      makeItem({ review_item_id: 'a', origin_session_id: 's1' }),
      makeItem({ review_item_id: 'b', origin_session_id: 's1' }),
      makeItem({ review_item_id: 'c', origin_session_id: 's2' }),
    ]);
    expect(summary.needsYouBySession).toEqual({ s1: 2, s2: 1 });
    expect(summary.totalNeedsYou).toBe(3);
  });

  test('sessionless needs_you items count toward the total but not any session', () => {
    const summary = summarizeReviewSessions([
      makeItem({ review_item_id: 'a', origin_session_id: null }),
      makeItem({ review_item_id: 'b', origin_session_id: 's1' }),
    ]);
    expect(summary.totalNeedsYou).toBe(2);
    expect(summary.needsYouBySession).toEqual({ s1: 1 });
  });

  test('a resolved item stops attributing to its session', () => {
    const summary = summarizeReviewSessions([
      makeItem({ review_item_id: 'a', origin_session_id: 's1', status: 'approved' }),
    ]);
    expect(summary.needsYouBySession.s1).toBeUndefined();
    expect(summary.totalNeedsYou).toBe(0);
  });
});
