import { describe, expect, test } from 'bun:test';

import { genuiToMarkdown } from './markdown';
import { HOTEL } from './test-fixtures';

describe('markdown fallback', () => {
  test('replaces blocks, keeps prose, never leaks source', () => {
    const md = genuiToMarkdown(`Here you go.\n\n\`\`\`openui\n${HOTEL}\n\`\`\`\n\nThanks.`);
    expect(md).toContain('Here you go.');
    expect(md).toContain('- **Options checked:** 24');
    expect(md).toContain('1. **Option A** — Closest to the venue (4.7 stars) [Open](https://example.com/a)');
    expect(md).toContain('> **Tip** Book by Friday');
    expect(md).toContain('Thanks.');
    expect(md).not.toContain('root =');
  });

  test('prose and blocks are separated by exactly one blank line', () => {
    expect(genuiToMarkdown('Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```\n\nBye.')).toBe('Done.\n\n[shipped]\n\nBye.');
  });

  test('text without a block is returned as the same string', () => {
    const text = 'No UI here, even with the word openui.';
    expect(genuiToMarkdown(text)).toBe(text);
  });

  test('charts and maps carry their source', () => {
    const md = genuiToMarkdown(
      '```openui\nroot = Stack([c, m])\nc = BarChart(["Q1","Q2"], [s], "billing export", "USD")\ns = Series("Revenue", [1200, 1500])\nm = Map([p], "places tool")\np = Marker(48.85, 2.35, "Center")\n```',
    );
    expect(md).toContain('| Q1 | 1,200 |');
    expect(md).toContain('Source: billing export');
    expect(md).toContain('https://www.openstreetmap.org/?mlat=48.85&mlon=2.35');
    expect(md).toContain('Source: places tool');
  });

  test('tabs and accordion expand every panel', () => {
    const md = genuiToMarkdown(
      '```openui\nroot = Stack([t])\nt = Tabs([x, y])\nx = Tab("One", [b1])\ny = Tab("Two", [b2])\nb1 = Badge("first")\nb2 = Badge("second")\n```',
    );
    expect(md).toContain('#### One\n\n[first]');
    expect(md).toContain('#### Two\n\n[second]');
  });

  test('a broken block yields no raw source', () => {
    expect(genuiToMarkdown('Hi\n\n```openui\nthis is not openui at all\n```')).toBe('Hi');
  });

  test('a block cut off mid-statement keeps its valid parts and says so', () => {
    expect(genuiToMarkdown('```openui\nroot = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "unfin')).toBe(
      '[kept]\n\n*Response was cut off.*',
    );
  });

  test('a capitalized fence tag is still a block', () => {
    expect(genuiToMarkdown('Hi\n\n```OpenUI\nroot = Stack([b])\nb = Badge("x")\n```')).toBe('Hi\n\n[x]');
  });

  test('a newer version yields the unsupported note', () => {
    expect(genuiToMarkdown('```openui-v2\nroot = Stack([])\n```')).toBe('*This content needs a newer version of Kortix.*');
  });

  test('streaming: an unfinished statement is left out and no cut-off note is shown', () => {
    const text = '```openui\nroot = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "unfin';
    expect(genuiToMarkdown(text, { streaming: true })).toBe('[kept]');
    expect(genuiToMarkdown(text, { streaming: false })).toBe('[kept]\n\n*Response was cut off.*');
  });

  test('streaming applies only to the unclosed last block', () => {
    const closed = '```openui\nroot = Stack([a, b])\na = Badge("one")\nb = Callout("info", "unfin\n```';
    expect(genuiToMarkdown(`${closed}\n\nMore.`, { streaming: true })).toBe('[one]\n\n*Response was cut off.*\n\nMore.');
  });
});

const BLOCK = '```openui\nroot = Stack([b])\nb = Badge("x")\n```';
const prefixed = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');

describe('blocks inside lists and blockquotes', () => {
  test('a block indented under a nested list item converts and keeps the indentation', () => {
    expect(genuiToMarkdown(`Intro.\n\n- Item\n  - Nested\n\n${prefixed(BLOCK, '    ')}`)).toBe(
      'Intro.\n\n- Item\n  - Nested\n\n    [x]',
    );
  });

  test('a block in a blockquote converts and keeps the quote marker on every line', () => {
    expect(genuiToMarkdown(`Intro.\n\n${prefixed(BLOCK, '> ')}`)).toBe('Intro.\n\n> [x]');
    const tabs =
      '```openui\nroot = Stack([t])\nt = Tabs([x, y])\nx = Tab("One", [b1])\ny = Tab("Two", [b2])\nb1 = Badge("first")\nb2 = Badge("second")\n```';
    expect(genuiToMarkdown(prefixed(tabs, '> '))).toBe('> #### One\n>\n> [first]\n>\n> #### Two\n>\n> [second]');
  });

  test('a CRLF block in a blockquote converts', () => {
    const text = `Intro.\r\n\r\n${prefixed(BLOCK, '> ').replace(/\n/g, '\r\n')}`;
    const md = genuiToMarkdown(text);
    expect(md).not.toContain('root =');
    expect(md).toBe('Intro.\r\n\r\n> [x]');
  });

  test('the block ends where its blockquote ends', () => {
    expect(genuiToMarkdown('> ```openui\n> root = Stack([b])\n> b = Badge("x")\nAfter.')).toBe('> [x]\nAfter.');
  });

  test('a fence opened on the list-marker line converts; the marker stays on the first line', () => {
    expect(genuiToMarkdown('Steps:\n\n- ```openui\n  root = Stack([b])\n  b = Badge("x")\n  ```\n- next')).toBe(
      'Steps:\n\n- [x]\n- next',
    );
    const tabs = '```openui\nroot = Stack([t])\nt = Tabs([x, y])\nx = Tab("One", [b1])\ny = Tab("Two", [b2])\nb1 = Badge("first")\nb2 = Badge("second")\n```';
    const listed = tabs.split('\n').map((line, i) => (i === 0 ? `12. ${line}` : `    ${line}`)).join('\n');
    expect(genuiToMarkdown(listed)).toBe('12. #### One\n\n    [first]\n\n    #### Two\n\n    [second]');
  });

  test('blockquote body lines may space the marker differently from the opener', () => {
    expect(genuiToMarkdown('> ```openui\n>root = Stack([b])\n>  b = Badge("x")\n>```')).toBe('> [x]');
  });

  test('an example inside another fence is left alone', () => {
    const text = `\`\`\`\`md\n${prefixed(BLOCK, '> ')}\n\`\`\`\`\n\n- Item\n\n    \`\`\`text\n    > \`\`\`openui\n    \`\`\``;
    expect(genuiToMarkdown(text)).toBe(text);
  });
});

describe('hostile input', () => {
  test('80,000 newlines convert in linear time', () => {
    const started = performance.now();
    expect(genuiToMarkdown(`a${'\n'.repeat(80_000)}z\n${BLOCK}\n${'\n'.repeat(80_000)}`)).toBe(`a${'\n'.repeat(80_000)}z\n\n[x]`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('a 40 KB fence-like line converts in linear time', () => {
    const started = performance.now();
    const line = `\`\`\`${'a'.repeat(40_000)}\``;
    expect(genuiToMarkdown(`openui\n${line}`)).toBe(`openui\n${line}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('20,000 nested brackets never throw', () => {
    const block = `root = ${'Stack(['.repeat(20_000)}Badge("x")${'])'.repeat(20_000)}`;
    expect(genuiToMarkdown(`hi\n\n\`\`\`openui\n${block}\n\`\`\``)).toBe('hi');
  });

  test('a 1 MB block is dropped quickly', () => {
    const started = performance.now();
    const md = genuiToMarkdown(`hi\n\n\`\`\`openui\nroot = Stack([c])\nc = Callout("info", "${'a'.repeat(1_000_000)}")\n\`\`\``);
    expect(md).toBe('hi');
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('many fences convert in bounded time', () => {
    const started = performance.now();
    const md = genuiToMarkdown(Array.from({ length: 1_000 }, () => BLOCK).join('\n\n'));
    expect(md.split('\n\n')).toHaveLength(1_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

