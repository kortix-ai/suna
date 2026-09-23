import { describe, expect, test } from 'bun:test';

import { parseReplyContexts, quoteMarker, serializeReplyContext, stripReplyContexts } from './reply-context';

// The regex versions of the two parsers, kept ONLY as parity oracles. Their
// lazy body re-scanned the rest of the message for every opener that never
// closed: 240k characters of `<reply_context>` took ~1 s with Bun.
const LEGACY_BLOCK_RE = /<reply_context\b[^>]*>([\s\S]*?)<\/reply_context>\n?/g;

const legacy = {
  parse(text: string): { cleanText: string; quotes: string[] } {
    const quotes: string[] = [];
    const cleanText = text
      .replace(LEGACY_BLOCK_RE, (_full, rawBody: string) => {
        const index = quotes.length;
        quotes.push(rawBody.split('&lt;/reply_context&gt;').join('</reply_context>').trim());
        return quoteMarker(index);
      })
      .trim();
    return { cleanText, quotes };
  },
  strip(text: string): string {
    return text
      .replace(/<reply_context\b[^>]*>[\s\S]*?<\/reply_context>\n?/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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

// `<reply_contextx>` and `<reply_context-x>` pin the `\b` after the name: a
// word character there is a different tag, a `-` is not.
const TOKENS = [
  '<reply_context>',
  '</reply_context>',
  '<reply_context',
  '<reply_context a="1">',
  '<reply_context\n>',
  '<reply_contextx>',
  '<reply_context-x>',
  '<REPLY_CONTEXT>',
  '</reply_context',
  '</REPLY_CONTEXT>',
  '&lt;/reply_context&gt;',
  '>',
  ' ',
  '\n',
  '\n\n\n',
  'quoted',
  'answer',
];

/** 3000 strings of up to 20 tokens each. */
function samples(): string[] {
  const next = random(29);
  return Array.from({ length: 3000 }, () => {
    let text = '';
    const length = Math.floor(next() * 21);
    for (let i = 0; i < length; i++) text += TOKENS[Math.floor(next() * TOKENS.length)];
    return text;
  });
}

describe('each reply_context parser returns exactly what its regex returned', () => {
  test('parseReplyContexts on 3000 random strings', () => {
    let matched = 0;
    for (const text of samples()) {
      const expected = legacy.parse(text);
      expect(parseReplyContexts(text)).toEqual(expected);
      if (expected.quotes.length > 0) matched++;
    }
    // The samples must exercise real blocks, not only plain text.
    expect(matched).toBeGreaterThan(800);
  });

  test('stripReplyContexts on 3000 random strings', () => {
    for (const text of samples()) expect(stripReplyContexts(text)).toBe(legacy.strip(text));
  });

  test('serialized quotes round-trip through the parser', () => {
    // A quote that already holds the escaped text `&lt;/reply_context&gt;`
    // comes back unescaped; the wire format has no escape for its own escape.
    const plain = TOKENS.filter((token) => !token.includes('&lt;'));
    const next = random(31);
    for (let i = 0; i < 500; i++) {
      const pieces: string[] = [];
      const count = 1 + Math.floor(next() * 4);
      for (let j = 0; j < count; j++) pieces.push(plain[Math.floor(next() * plain.length)]!.trim() || 'q');
      const quote = pieces.join(' ');
      expect(parseReplyContexts(`${serializeReplyContext(quote)}\nreply`).quotes).toEqual([quote]);
    }
  });
});

describe('no message can freeze the tab that parses its quotes', () => {
  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });

  // 240k characters. Each took ~1 s with the regexes, and each doubling of
  // the text quadrupled the time.
  within('16k <reply_context> openers that never close (parse)', () =>
    parseReplyContexts('<reply_context>'.repeat(16_000)));
  within('16k <reply_context> openers that never close (strip)', () =>
    stripReplyContexts('<reply_context>'.repeat(16_000)));
  within('one <reply_context opener and 240k characters with no >', () =>
    parseReplyContexts(`<reply_context${' '.repeat(240_000)}x`));
  within('16k <reply_contextx> openers that fail the name boundary', () =>
    parseReplyContexts(`${'<reply_contextx>'.repeat(15_000)}</reply_context>`));
});
