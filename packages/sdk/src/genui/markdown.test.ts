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
});
