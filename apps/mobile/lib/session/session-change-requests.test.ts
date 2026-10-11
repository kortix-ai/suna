import { describe, expect, test } from 'bun:test';
import type { ReviewItem } from '@kortix/sdk';

import { anchorChangeRequests, changeRequestStatusLabel, sessionChangeRequests } from './session-change-requests';

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

describe('anchorChangeRequests', () => {
  const at = (iso: string) => Date.parse(iso);
  const turns = [
    { key: 't1', startedAt: at('2026-09-27T10:00:00.000Z') },
    { key: 't2', startedAt: at('2026-09-27T11:00:00.000Z') },
    { key: 't3', startedAt: at('2026-09-27T12:00:00.000Z') },
  ];

  test('anchors each change request to the turn that was running when it opened (web anchor-outcomes)', () => {
    const items = [
      change('cr:a', { createdAt: '2026-09-27T10:30:00.000Z' }),
      change('cr:b', { createdAt: '2026-09-27T11:05:00.000Z' }),
      change('cr:c', { createdAt: '2026-09-27T11:10:00.000Z' }),
    ];
    const byTurn = anchorChangeRequests(sessionChangeRequests(items, 'ps-1'), turns);
    expect(byTurn.get('t1')?.map((item) => item.id)).toEqual(['cr:a']);
    expect(byTurn.get('t2')?.map((item) => item.id)).toEqual(['cr:b', 'cr:c']);
    // The newest turn did not open one: no card follows the thread to its end.
    expect(byTurn.has('t3')).toBe(false);
  });

  test('nothing is dropped: before the first turn → first, after the last → last', () => {
    const items = [
      change('cr:early', { createdAt: '2026-09-27T09:00:00.000Z' }),
      change('cr:late', { createdAt: '2026-09-27T13:00:00.000Z' }),
    ];
    const byTurn = anchorChangeRequests(sessionChangeRequests(items, 'ps-1'), turns);
    expect(byTurn.get('t1')?.map((item) => item.id)).toEqual(['cr:early']);
    expect(byTurn.get('t3')?.map((item) => item.id)).toEqual(['cr:late']);
  });

  test('turn order does not matter, and a turn with no start time is skipped', () => {
    const items = [change('cr:a', { createdAt: '2026-09-27T11:30:00.000Z' })];
    const byTurn = anchorChangeRequests(sessionChangeRequests(items, 'ps-1'), [turns[2], { key: 'x', startedAt: null }, turns[1], turns[0]]);
    expect(byTurn.get('t2')?.map((item) => item.id)).toEqual(['cr:a']);
  });

  test('no turns → no anchors', () => {
    expect(anchorChangeRequests(sessionChangeRequests([change('cr:a')], 'ps-1'), []).size).toBe(0);
  });
});
