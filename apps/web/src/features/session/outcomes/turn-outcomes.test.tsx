import { describe, expect, test } from 'bun:test';

import type { Outcome } from './outcome-types';
import { MAX_VISIBLE_OUTCOMES, visibleOutcomes } from './turn-outcomes';

const make = (n: number): Outcome[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `cr:${i}`,
    kind: 'change_request' as const,
    title: `Change request #${i}`,
    description: '',
    status: { label: 'Waiting for you', tone: 'warning' as const },
    at: i,
    meta: [],
    action: { label: 'Review', intent: 'open' as const },
    resourceHref: null,
  }));

describe('visibleOutcomes', () => {
  test('shows every outcome when the turn is under the cap', () => {
    const { shown, overflow } = visibleOutcomes(make(3));
    expect(shown).toHaveLength(3);
    expect(overflow).toBe(0);
  });

  test('caps at four and reports the remainder', () => {
    const { shown, overflow } = visibleOutcomes(make(7));
    expect(shown).toHaveLength(MAX_VISIBLE_OUTCOMES);
    expect(overflow).toBe(3);
  });

  test('exactly at the cap reports no overflow', () => {
    expect(visibleOutcomes(make(MAX_VISIBLE_OUTCOMES)).overflow).toBe(0);
  });

  test('an empty turn reports nothing to show', () => {
    const { shown, overflow } = visibleOutcomes([]);
    expect(shown).toEqual([]);
    expect(overflow).toBe(0);
  });
});
