import { Editor } from '@tiptap/core';
import { describe, expect, test } from 'bun:test';

import { docToMarkdown, markdownToDoc, memoryLinkTarget, superscript } from './body-doc';
import { memoryBodyExtensions } from './body-extensions';

/** Markdown → the editor's real schema (no DOM: no `element`) → Markdown. */
function roundTrip(markdown: string): string {
  const editor = new Editor({ extensions: memoryBodyExtensions(), content: markdownToDoc(markdown) });
  try {
    return docToMarkdown(editor.getJSON());
  } finally {
    editor.destroy();
  }
}

const SEEDED = [
  'Every Monday the report lists signups, trials started and paid conversions for the past week, with one line on what changed.',
  'Write in plain words. No hype, no exclamation marks. Name the outcome, then the feature.',
  'Priya leads design for the Q4 launch and approves all launch copy.',
  'Pricing stays at $49 per seat. There is no launch discount.',
  'The Q4 launch ships on November 12. The new pricing page, a three-email sequence and a press push through the agency all go out that morning.⟦1⟧\n\nPricing stays at $49 per seat, with no launch discount.⟦2⟧ Priya Shah owns the launch. Writer drafts all launch copy and Priya approves it before it ships.⟦3⟧\n\nEmail 2 of 3 is due October 30. The agency sends the press list by November 5.⟦4⟧',
];

const RICH = [
  '## Owners',
  '',
  '- **Priya Shah** owns the launch.⟦1⟧',
  '- Writer drafts the copy; see [the plan](https://example.com/plan).',
  '',
  '### Dates',
  '',
  '1. Email 2 of 3: `Oct 30`',
  '2. Press list: Nov 5⟦2⟧',
  '',
  'A paragraph on two lines',
  'keeps its line break.',
  '',
  '```ts',
  'const launch = "2026-11-12";',
  '```',
].join('\n');

/** Every feature agents write in memory files (`MEMORY.md`, `profile.md`). */
const FULL = [
  '# Index',
  '',
  '- [profile.md](profile.md) — Name.',
  '- [Priya](people/priya.md) leads design; *italic*, ~~old~~ and **bold** text.',
  '  - Nested item one',
  '  - Nested item two',
  '    1. Deeper numbered',
  '',
  '1. First',
  '2. Second',
  '',
  '- [x] Pricing decided',
  '- [ ] Press list',
  '',
  '> A quote that spans',
  '> two lines.',
  '>',
  '> And a second paragraph.',
  '',
  '---',
  '',
  '| Owner | Due |',
  '| --- | --- |',
  '| Priya | Nov 12 |',
  '| Writer | Oct 30 |',
  '',
  'A hard break\\',
  'and the next line, a bare link https://example.com/x and file_name.md.',
].join('\n');

describe('memory body: Markdown → editor → Markdown', () => {
  test.each(SEEDED.map((body, i) => [i + 1, body] as const))('seeded page %i is unchanged', (_, body) => {
    expect(roundTrip(body)).toBe(body);
  });

  test('headings, lists, bold, code, links, fences, soft breaks and source tokens are unchanged', () => {
    expect(roundTrip(RICH)).toBe(RICH);
  });

  test('relative and external links, italic, strike, nested and task lists, quotes, rules, tables and hard breaks are unchanged', () => {
    expect(roundTrip(FULL)).toBe(FULL);
  });

  test('a relative link names the memory file beside the open one; a URL opens as a URL', () => {
    const from = '/Users/jay/Memory/MEMORY.md';
    expect(memoryLinkTarget('profile.md', from)).toEqual({ path: '/Users/jay/Memory/profile.md' });
    expect(memoryLinkTarget('people/priya.md', from)).toEqual({ path: '/Users/jay/Memory/people/priya.md' });
    expect(memoryLinkTarget('../Notes.md', '/Users/jay/Memory/people/priya.md')).toEqual({ path: '/Users/jay/Memory/Notes.md' });
    expect(memoryLinkTarget('https://example.com', from)).toEqual({ url: 'https://example.com' });
    expect(memoryLinkTarget('mailto:a@example.com', from)).toBeNull();
  });

  test('a source token is one node with its number', () => {
    const doc = markdownToDoc('Nov 12.⟦12⟧');
    expect(doc.content?.[0]?.content?.[1]).toEqual({ type: 'memorySource', attrs: { number: 12 } });
    expect(superscript(12)).toBe('¹²');
  });

  test('an empty body is one empty paragraph, saved as an empty string', () => {
    expect(roundTrip('')).toBe('');
  });
});
