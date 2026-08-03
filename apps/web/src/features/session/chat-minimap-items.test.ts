import { describe, expect, test } from 'bun:test';

import type { Turn } from '@/ui';

import {
  DASH_WIDTH_MAX,
  DASH_WIDTH_MIN,
  MAX_DASHES,
  buildSegments,
  dashOpacity,
  dashWidth,
  downsampleDashes,
  extractMinimapItem,
  extractUserText,
  nearestDashRow,
  truncate,
  type MinimapItem,
} from './chat-minimap-items';

function turnWithParts(parts: Record<string, unknown>[]): Turn {
  return {
    userMessage: { info: { id: 'u1' }, parts },
    assistantMessages: [],
  } as unknown as Turn;
}

function makeItems(count: number): MinimapItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    text: `message ${i}`,
    segments: [{ text: `message ${i}` }],
    attachments: [],
  }));
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

  test('returns empty string for a turn with nothing to preview', () => {
    expect(extractUserText(turnWithParts([{ type: 'reasoning', text: 'thinking' }]))).toBe('');
  });
});

describe('extractMinimapItem', () => {
  test('returns null when the turn has neither text nor attachments', () => {
    expect(extractMinimapItem(turnWithParts([]))).toBeNull();
  });

  test('keeps a message that is only attachments, labelled by the first file', () => {
    const item = extractMinimapItem(
      turnWithParts([
        { type: 'file', id: 'f1', mime: 'text/plain', filename: 'hero.tsx' },
        { type: 'file', id: 'f2', mime: 'text/plain', filename: 'landing.test.ts' },
      ]),
    );
    expect(item).not.toBeNull();
    expect(item!.text).toBe('hero.tsx');
    expect(item!.attachments.map((a) => a.name)).toEqual(['hero.tsx', 'landing.test.ts']);
  });

  test('strips agent-mention XML and marks the mention in the segments', () => {
    const item = extractMinimapItem(
      turnWithParts([
        {
          type: 'text',
          text: 'ask @Make Interfaces Feel Better to review\n<agent_ref name="Make Interfaces Feel Better" />',
        },
      ]),
    );
    expect(item!.text).toBe('ask @Make Interfaces Feel Better to review');
    expect(item!.segments).toEqual([
      { text: 'ask ' },
      { text: 'Make Interfaces Feel Better', mention: 'agent' },
      { text: ' to review' },
    ]);
  });

  test('lists file-mention references as attachments', () => {
    const item = extractMinimapItem(
      turnWithParts([
        {
          type: 'text',
          text: 'check @hero.tsx\n<file_ref path="app/hero.tsx" name="hero.tsx" />',
        },
      ]),
    );
    expect(item!.attachments.map((a) => a.name)).toEqual(['hero.tsx']);
    expect(item!.segments).toEqual([{ text: 'check ' }, { text: 'hero.tsx', mention: 'file' }]);
  });

  test('deduplicates a file that arrives as both a part and a reference', () => {
    const item = extractMinimapItem(
      turnWithParts([
        { type: 'file', id: 'f1', mime: 'text/plain', filename: 'hero.tsx' },
        { type: 'text', text: '<file_ref path="app/hero.tsx" name="hero.tsx" />' },
      ]),
    );
    expect(item!.attachments).toHaveLength(1);
  });
});

describe('buildSegments', () => {
  test('returns one plain segment when there are no mentions', () => {
    expect(buildSegments('just text', [])).toEqual([{ text: 'just text' }]);
  });

  test('returns nothing for empty text', () => {
    expect(buildSegments('', [{ name: 'Agent', kind: 'agent' }])).toEqual([]);
  });

  test('prefers the longest matching name so multi-word mentions win', () => {
    const segments = buildSegments('run @Make It Better now', [
      { name: 'Make', kind: 'agent' },
      { name: 'Make It Better', kind: 'agent' },
    ]);
    expect(segments).toEqual([
      { text: 'run ' },
      { text: 'Make It Better', mention: 'agent' },
      { text: ' now' },
    ]);
  });

  test('falls back to a whitespace-delimited token for an unknown mention', () => {
    expect(buildSegments('see @utils.ts here', [])).toEqual([
      { text: 'see ' },
      { text: 'utils.ts', mention: 'file' },
      { text: ' here' },
    ]);
  });

  test('marks every occurrence of a repeated mention', () => {
    const segments = buildSegments('@Bot and @Bot', [{ name: 'Bot', kind: 'agent' }]);
    expect(segments.filter((s) => s.mention === 'agent')).toHaveLength(2);
  });
});

describe('dashWidth', () => {
  test('the focused dash is the longest', () => {
    expect(dashWidth(0)).toBe(DASH_WIDTH_MAX);
  });

  test('shortens monotonically with distance and never goes below the floor', () => {
    for (let d = 1; d < 12; d++) {
      expect(dashWidth(d)).toBeLessThanOrEqual(dashWidth(d - 1));
      expect(dashWidth(d)).toBeGreaterThanOrEqual(DASH_WIDTH_MIN);
    }
  });

  test('treats an unfocused rail (Infinity) as the floor', () => {
    expect(dashWidth(Infinity)).toBe(DASH_WIDTH_MIN);
  });
});

describe('dashOpacity', () => {
  test('only the focused dash is fully opaque', () => {
    expect(dashOpacity(0)).toBe(1);
    expect(dashOpacity(1)).toBeLessThan(1);
  });

  test('dims monotonically and never disappears', () => {
    for (let d = 1; d < 12; d++) {
      expect(dashOpacity(d)).toBeLessThanOrEqual(dashOpacity(d - 1));
      expect(dashOpacity(d)).toBeGreaterThanOrEqual(0.2);
    }
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

describe('nearestDashRow', () => {
  test('returns -1 when there is no active turn', () => {
    expect(nearestDashRow(downsampleDashes(makeItems(5)), -1)).toBe(-1);
  });

  test('row equals message index when the rail is not down-sampled', () => {
    expect(nearestDashRow(downsampleDashes(makeItems(10)), 4)).toBe(4);
  });

  test('snaps to the row whose message is nearest for a down-sampled rail', () => {
    const dashes = downsampleDashes(makeItems(100));
    const row = nearestDashRow(dashes, 50);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(row).toBeLessThan(dashes.length);
    const bestDist = Math.min(...dashes.map((d) => Math.abs(d.index - 50)));
    expect(Math.abs(dashes[row].index - 50)).toBe(bestDist);
  });
});
