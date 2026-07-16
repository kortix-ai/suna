import { describe, expect, test } from 'bun:test';

import type { Turn } from '@/ui';

import {
  MAX_DASHES,
  downsampleDashes,
  extractUserText,
  nearestDashIndex,
  truncate,
  type MinimapItem,
} from './chat-minimap-items';

function turnWithParts(parts: { type: string; text?: string }[]): Turn {
  return {
    userMessage: { info: { id: 'u1' }, parts },
    assistantMessages: [],
  } as unknown as Turn;
}

function makeItems(count: number): MinimapItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: `m${i}`, text: `message ${i}` }));
}

describe('truncate', () => {
  test('returns short text unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  test('cuts long text at the limit and appends an ellipsis', () => {
    expect(truncate('a'.repeat(20), 10)).toBe('a'.repeat(10) + '…');
  });

  test('trims trailing whitespace before the ellipsis', () => {
    expect(truncate('hello world again', 6)).toBe('hello…');
  });
});

describe('extractUserText', () => {
  test('joins text parts and ignores non-text parts', () => {
    const turn = turnWithParts([
      { type: 'text', text: 'first' },
      { type: 'file' },
      { type: 'text', text: 'second' },
    ]);
    expect(extractUserText(turn)).toBe('first second');
  });

  test('strips kortix system tags and html tags', () => {
    const turn = turnWithParts([
      {
        type: 'text',
        text: '<kortix_system type="context">internal</kortix_system> ask <b>me</b>',
      },
    ]);
    expect(extractUserText(turn)).toBe('ask me');
  });

  test('collapses internal whitespace', () => {
    const turn = turnWithParts([{ type: 'text', text: 'line one\n\n   line two' }]);
    expect(extractUserText(turn)).toBe('line one line two');
  });

  test('caps very long messages', () => {
    const turn = turnWithParts([{ type: 'text', text: 'word '.repeat(100) }]);
    const text = extractUserText(turn);
    expect(text.length).toBeLessThanOrEqual(81);
    expect(text.endsWith('…')).toBe(true);
  });

  test('returns empty string for a turn with no text', () => {
    expect(extractUserText(turnWithParts([{ type: 'file' }]))).toBe('');
  });
});

describe('downsampleDashes', () => {
  test('keeps every item when at or under the max', () => {
    const items = makeItems(MAX_DASHES);
    const dashes = downsampleDashes(items);
    expect(dashes).toHaveLength(MAX_DASHES);
    expect(dashes.map((d) => d.index)).toEqual(items.map((_, i) => i));
  });

  test('down-samples evenly and keeps first and last message', () => {
    const items = makeItems(100);
    const dashes = downsampleDashes(items);
    expect(dashes).toHaveLength(MAX_DASHES);
    expect(dashes[0].index).toBe(0);
    expect(dashes[MAX_DASHES - 1].index).toBe(99);
    for (let i = 1; i < dashes.length; i++) {
      expect(dashes[i].index).toBeGreaterThan(dashes[i - 1].index);
    }
  });
});

describe('nearestDashIndex', () => {
  test('returns -1 when there is no active turn', () => {
    expect(nearestDashIndex(downsampleDashes(makeItems(5)), -1)).toBe(-1);
  });

  test('returns the active index itself when it has a dash', () => {
    expect(nearestDashIndex(downsampleDashes(makeItems(10)), 4)).toBe(4);
  });

  test('snaps to the nearest sampled dash for down-sampled rails', () => {
    const dashes = downsampleDashes(makeItems(100));
    const nearest = nearestDashIndex(dashes, 50);
    const dashIndexes = dashes.map((d) => d.index);
    expect(dashIndexes).toContain(nearest);
    const bestDist = Math.min(...dashIndexes.map((i) => Math.abs(i - 50)));
    expect(Math.abs(nearest - 50)).toBe(bestDist);
  });
});
