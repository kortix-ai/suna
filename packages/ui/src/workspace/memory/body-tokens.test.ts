import { describe, expect, test } from 'bun:test';

import { addedLine, memoryBlocks, memoryInlines } from './body-tokens';

const sources = new Set([1, 2]);

describe('memoryInlines', () => {
  test('splits text around source tokens', () => {
    expect(memoryInlines('Launch is Nov 12 ⟦1⟧ and pricing stays ⟦2⟧.', sources)).toEqual([
      { kind: 'text', text: 'Launch is Nov 12 ' },
      { kind: 'source', number: 1 },
      { kind: 'text', text: ' and pricing stays ' },
      { kind: 'source', number: 2 },
      { kind: 'text', text: '.' },
    ]);
  });

  test('a token whose number has no source renders nothing', () => {
    expect(memoryInlines('Owner is Priya ⟦7⟧.', sources)).toEqual([{ kind: 'text', text: 'Owner is Priya .' }]);
  });

  test('a token inside a code span stays text', () => {
    expect(memoryInlines('Write `⟦1⟧` to cite ⟦1⟧', sources)).toEqual([
      { kind: 'text', text: 'Write ' },
      { kind: 'code', text: '⟦1⟧' },
      { kind: 'text', text: ' to cite ' },
      { kind: 'source', number: 1 },
    ]);
  });

  test('bold and http links; other link schemes stay text', () => {
    expect(memoryInlines('**Q4** see [plan](https://example.com/p) or [x](javascript:alert(1))', sources)).toEqual([
      { kind: 'strong', text: 'Q4' },
      { kind: 'text', text: ' see ' },
      { kind: 'link', text: 'plan', href: 'https://example.com/p' },
      { kind: 'text', text: ' or [x](javascript:alert(1))' },
    ]);
  });
});

describe('memoryBlocks', () => {
  test('sections, facts, paragraphs and fenced code', () => {
    const body = [
      'Ship the Q4 launch',
      'on Nov 12.',
      '',
      '## Status',
      '- Launch date is Nov 12 ⟦1⟧',
      '- Pricing stays ⟦2⟧',
      '',
      '```',
      'not ⟦1⟧ a token',
      '```',
      '1. first',
    ].join('\n');
    expect(memoryBlocks(body, sources)).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'Ship the Q4 launch on Nov 12.' }] },
      { kind: 'heading', inlines: [{ kind: 'text', text: 'Status' }] },
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'text', text: 'Launch date is Nov 12 ' }, { kind: 'source', number: 1 }],
          [{ kind: 'text', text: 'Pricing stays ' }, { kind: 'source', number: 2 }],
        ],
      },
      { kind: 'code', text: 'not ⟦1⟧ a token' },
      { kind: 'list', ordered: true, items: [[{ kind: 'text', text: 'first' }]] },
    ]);
  });
});

describe('addedLine', () => {
  test('the fact an append added, without marker, token or closing period', () => {
    const before = '## Next steps\n- The agency sends the press list ⟦1⟧';
    const after = `${before}\n- Email 2 of 3 is due Oct 30. ⟦2⟧`;
    expect(addedLine(before, after)).toBe('Email 2 of 3 is due Oct 30');
  });

  test('null when the change only removed text', () => {
    expect(addedLine('- a\n- b', '- a')).toBeNull();
  });

  test('a repeated line counts once per occurrence', () => {
    expect(addedLine('- a', '- a\n- a')).toBe('a');
  });
});
