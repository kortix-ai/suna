import { describe, expect, test } from 'bun:test';
import type { ReviewItem } from '@kortix/sdk';

import { changeRequestStatusLabel, sessionChangeRequests } from './session-change-requests';

function change(id: string, over: Partial<ReviewItem> & { number?: number } = {}): ReviewItem {
  const { number, ...rest } = over;
  return {
    id,
    kind: 'change',
    status: 'needs_you',
    title: `CR ${id}`,
    createdAt: '2026-09-27T10:00:00.000Z',
    sessionId: 'ps-1',
    detail: { crId: id.slice(3), number, whatChanged: [], impact: '', verification: [] },
    ...rest,
  } as ReviewItem;
}

describe('sessionChangeRequests', () => {
  test('keeps only this session’s change requests, oldest first', () => {
    const items = [
      change('cr:b', { createdAt: '2026-09-27T12:00:00.000Z' }),
      change('cr:other', { sessionId: 'ps-2' }),
      { ...change('rv-1'), kind: 'approval' } as ReviewItem,
      change('cr:a', { createdAt: '2026-09-27T09:00:00.000Z' }),
    ];
    expect(sessionChangeRequests(items, 'ps-1').map((item) => item.id)).toEqual(['cr:a', 'cr:b']);
  });

  test('no project session or no items → none', () => {
    expect(sessionChangeRequests([change('cr:a')], undefined)).toEqual([]);
    expect(sessionChangeRequests(undefined, 'ps-1')).toEqual([]);
  });
});

describe('changeRequestStatusLabel', () => {
  test('names the number and the state, in web’s words', () => {
    expect(changeRequestStatusLabel(change('cr:a', { number: 8 }))).toBe('Change request #8 · Waiting for you');
    expect(changeRequestStatusLabel(change('cr:a', { number: 8, status: 'approved' }))).toBe('Change request #8 · Applied');
    expect(changeRequestStatusLabel(change('cr:a', { number: 8, status: 'rejected' }))).toBe('Change request #8 · Closed');
    expect(changeRequestStatusLabel(change('cr:a', { status: 'changes_requested' }))).toBe('Change request · Changes requested');
  });
});
