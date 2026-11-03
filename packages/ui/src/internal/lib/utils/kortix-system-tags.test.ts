import { describe, expect, test } from 'bun:test';

import { within } from '@kortix/shared/tool-output/testing';

import type { UiTranslator } from '../../../i18n';

import {
  extractKortixSystemMessages,
  kortixSystemElements,
  stripKortixSystemTags,
} from './kortix-system-tags';

// Each function here used a regex that was quadratic or cubic in the message.
// The regexes are kept ONLY as parity oracles.
const legacy = {
  strip(text: string) {
    if (!text) return '';
    return text.replace(/<kortix_system[^>]*>[\s\S]*?<\/kortix_system>/gi, '').trim();
  },
  elements(text: string) {
    const out: { type: string; source: string; body: string }[] = [];
    const re = /<kortix_system[^>]*?\btype="([^"]*)"[^>]*?\bsource="([^"]*)"[^>]*>([\s\S]*?)<\/kortix_system>/gi;
    for (let m = re.exec(text); m; m = re.exec(text)) out.push({ type: m[1]!, source: m[2]!, body: m[3]! });
    return out;
  },
};

/** Deterministic PRNG (mulberry32), so a failing case reproduces. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function samples(tokens: readonly string[], count = 3000): string[] {
  const next = random(31);
  return Array.from({ length: count }, () => {
    let text = '';
    const length = Math.floor(next() * 25);
    for (let i = 0; i < length; i++) text += tokens[Math.floor(next() * tokens.length)];
    return text;
  });
}

describe('stripKortixSystemTags', () => {
  test('returns exactly what the regex returned on 3000 random strings', () => {
    for (const text of samples(['<kortix_system', '<KORTIX_SYSTEM', '</kortix_system>', '</Kortix_System>', ' type="a"', '>',
      ' ', '\n', 'x', '<', '<\u212Aortix_system'])) {
      expect(stripKortixSystemTags(text)).toBe(legacy.strip(text));
    }
  });
});

describe('kortixSystemElements', () => {
  test('returns what the extract regex returned on 3000 random strings', () => {
    let compared = 0;
    let matched = 0;
    for (const text of samples(['<kortix_system', '<KORTIX_SYSTEM', ' type="a"', ' TYPE="b"', ' source="s"', ' SOURCE="t"',
      'type="', 'source="', '"', '>', '</kortix_system>', '</Kortix_System>', ' ', '\n', 'x', 'body',
      '<kortix_system type="a" source="s">', '<KORTIX_SYSTEM TYPE="b" Source="t">', '</kortix_system>'])) {
      const expected = legacy.elements(text);
      // The one intended difference: a `>` ends the tag, as it does for
      // stripKortixSystemTags. The regex read through a `>` inside a quoted value.
      if (expected.some((e) => e.type.includes('>') || e.source.includes('>'))) continue;
      expect(kortixSystemElements(text)).toEqual(expected);
      compared++;
      if (expected.length) matched++;
    }
    expect(compared).toBeGreaterThan(2400);
    expect(matched).toBeGreaterThan(200);
  });

  test('a > ends the tag, even inside a quoted value', () => {
    const text = '<kortix_system type="a>b" source="c">x</kortix_system>';
    expect(legacy.elements(text)).toEqual([{ type: 'a>b', source: 'c', body: 'x' }]);
    expect(kortixSystemElements(text)).toEqual([]);
    // The tag is still stripped from the visible text, as before.
    expect(stripKortixSystemTags(text)).toBe('');
  });

  test('type must come before source, and both names are whole words in any case', () => {
    expect(kortixSystemElements('<kortix_system source="s" type="t">x</kortix_system>')).toEqual([]);
    expect(kortixSystemElements('<kortix_systemtype="t" source="s">x</kortix_system>')).toEqual([]);
    expect(kortixSystemElements('<KORTIX_SYSTEM TYPE="t" Source="s">x</kortix_system>')).toEqual([
      { type: 't', source: 's', body: 'x' },
    ]);
  });

  test('extractKortixSystemMessages still labels what it finds', () => {
    const t = Object.assign((key: string) => key, { raw: (key: string) => key }) as unknown as UiTranslator;
    const text = '<kortix_system type="rules" source="kortix-rules">follow them</kortix_system>';
    expect(extractKortixSystemMessages(text, t)).toEqual([
      { type: 'rules', source: 'kortix-rules', label: 'text6725e7bbcd28', detail: 'rules' },
    ]);
  });
});

describe('no message can freeze the tab that parses it', () => {
  // Quadratic: ~1 s here.
  within('strip: 16k openers that never close', () => stripKortixSystemTags('<kortix_system>'.repeat(16_000)));
  // Cubic: 6.6 s at 30k characters with Bun, 2.7 s with Node.
  within('elements: 1,300 unclosed type attributes (30k chars)', () =>
    kortixSystemElements('<kortix_system type="" '.repeat(1_300)));
  // At these sizes the cubic regexes would run for about an hour.
  within('elements: 240k characters of unclosed attributes', () =>
    kortixSystemElements('<kortix_system type="" '.repeat(10_500)));
});
