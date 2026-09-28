import { describe, expect, test } from 'bun:test';

import { queueHeaderLabel, restoreQueued } from './queue-undo';

const m = (id: string, sessionId = 's1') => ({ id, sessionId, text: id, timestamp: 0 });

describe('restoreQueued', () => {
  test('puts removed messages back at their original positions', () => {
    const snapshot = [m('a'), m('b'), m('c')];
    const current = [m('a'), m('c')];
    expect(restoreQueued(current, snapshot, ['b']).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  test('restores a cleared session', () => {
    const snapshot = [m('a'), m('x', 's2'), m('b')];
    const current = [m('x', 's2')];
    expect(restoreQueued(current, snapshot, ['a', 'b']).map((x) => x.id)).toEqual(['a', 'x', 'b']);
  });

  test('keeps messages queued after the removal, at the end', () => {
    const snapshot = [m('a'), m('b')];
    const current = [m('a'), m('new')];
    expect(restoreQueued(current, snapshot, ['b']).map((x) => x.id)).toEqual(['a', 'b', 'new']);
  });

  test('does not resurrect a message sent since the snapshot', () => {
    const snapshot = [m('a'), m('b'), m('c')];
    // `a` was sent (dequeued) after `b` was removed.
    const current = [m('c')];
    expect(restoreQueued(current, snapshot, ['b']).map((x) => x.id)).toEqual(['b', 'c']);
  });

  test('never duplicates a message that is already back', () => {
    const snapshot = [m('a'), m('b')];
    const current = [m('a'), m('b')];
    expect(restoreQueued(current, snapshot, ['b']).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('queueHeaderLabel', () => {
  test('reads "Up next · N"', () => {
    expect(queueHeaderLabel(1)).toBe('Up next · 1');
    expect(queueHeaderLabel(3)).toBe('Up next · 3');
  });
});
