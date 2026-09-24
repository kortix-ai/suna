import { describe, expect, test } from 'bun:test';
import {
  indexOfIgnoreCase,
  referenceHeaders,
  removeSpans,
  replaceSpans,
  selfClosingTags,
  tagBlocks,
  xmlBlocks,
} from './tag-blocks';

// Every scanner here replaces a regex that was super-linear on user text. Each
// one must return exactly what its regex returned. The regexes below are kept
// ONLY as parity oracles.

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

/** `count` strings, each up to `maxTokens` tokens drawn from `tokens`. */
function samples(tokens: readonly string[], count = 3000, maxTokens = 24, seed = 7): string[] {
  const next = random(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let text = '';
    const length = Math.floor(next() * (maxTokens + 1));
    for (let j = 0; j < length; j++) text += tokens[Math.floor(next() * tokens.length)];
    out.push(text);
  }
  return out;
}

/** Runs `check` on every sample and proves the samples were not vacuous. */
function fuzz(tokens: readonly string[], check: (text: string) => number) {
  let matched = 0;
  for (const text of samples(tokens)) matched += check(text) > 0 ? 1 : 0;
  // At least a fifth of the samples must contain a match, or the fuzz proves nothing.
  expect(matched).toBeGreaterThan(600);
}

const within = (label: string, run: () => unknown) =>
  test(label, () => {
    const started = performance.now();
    run();
    expect(performance.now() - started).toBeLessThan(100);
  });

describe('tagBlocks: <name>…</name>', () => {
  const legacy = (text: string) =>
    [...text.matchAll(/<reply_context>([\s\S]*?)<\/reply_context>/g)].map((m) => ({
      index: m.index!,
      end: m.index! + m[0].length,
      attrs: '',
      body: m[1]!,
    }));

  test('matches the legacy regex on 3000 random strings', () => {
    fuzz(
      ['<reply_context>', '</reply_context>', '<reply_context', '</reply_context', '<REPLY_CONTEXT>', '</Reply_Context>',
        '<reply_context >', '<reply_contextx>', '<', '>', '/', ' ', '\n', 'x'],
      (text) => {
        const expected = legacy(text);
        expect(tagBlocks(text, 'reply_context')).toEqual(expected);
        return expected.length;
      },
    );
  });

  test('limit: 1 is the first match of the non-global regex', () => {
    for (const text of samples(['<trigger_event>', '</trigger_event>', ' ', '\n', 'x', '{}'])) {
      const m = text.match(/<trigger_event>\s*([\s\S]*?)\s*<\/trigger_event>/);
      const [block] = tagBlocks(text, 'trigger_event', { limit: 1 });
      expect(block ? block.body.trim() : null).toBe(m ? m[1]! : null);
      expect(block ? block.index : -1).toBe(m ? m.index! : -1);
    }
  });

  test('an unclosed opener, a stray closer, and a nested-looking body', () => {
    expect(tagBlocks('a <reply_context> never closed', 'reply_context')).toEqual([]);
    expect(tagBlocks('</reply_context> before <reply_context>x', 'reply_context')).toEqual([]);
    expect(tagBlocks('<reply_context>1<reply_context>2</reply_context>3</reply_context>', 'reply_context')).toEqual([
      { index: 0, end: 48, attrs: '', body: '1<reply_context>2' },
    ]);
    expect(tagBlocks('', 'reply_context')).toEqual([]);
    expect(tagBlocks(undefined as never, 'reply_context')).toEqual([]);
  });
});

describe('tagBlocks: <name …>…</name>, ignoring case', () => {
  const legacy = (text: string) =>
    [...text.matchAll(/<kortix_system([^>]*)>([\s\S]*?)<\/kortix_system>/gi)].map((m) => ({
      index: m.index!,
      end: m.index! + m[0].length,
      attrs: m[1]!,
      body: m[2]!,
    }));
  const scan = (text: string) => tagBlocks(text, 'kortix_system', { attributes: 'any', ignoreCase: true });

  test('matches the legacy regex on 3000 random strings', () => {
    fuzz(
      ['<kortix_system', '<KORTIX_SYSTEM', '<Kortix_System', '</kortix_system>', '</KORTIX_SYSTEM>', '</kortix_System>',
        '</kortix_system >', '<kortix_systemx', '>', ' ', '\n', 'type="a"', 'x', '<', '/',
        // Non-ASCII letters that case-fold to ASCII ones must NOT match: the
        // regex had no `u` flag, so only ASCII letters fold.
        '<\u212Aortix_system', '</\u212Aortix_system>', '<kortix_\u017Fystem'],
      (text) => {
        const expected = legacy(text);
        expect(scan(text)).toEqual(expected);
        return expected.length;
      },
    );
  });

  test('the Kelvin sign is not a K', () => {
    expect(scan('<\u212Aortix_system>x</kortix_system>')).toEqual([]);
    expect(scan('<KORTIX_SYSTEM type="a">x</Kortix_System>')).toEqual([
      { index: 0, end: 41, attrs: ' type="a"', body: 'x' },
    ]);
  });
});

describe('tagBlocks: <name whitespace …>…</name>', () => {
  test('matches the legacy dcp-notification regex on 3000 random strings', () => {
    const legacy = (text: string) =>
      [...text.matchAll(/<dcp-notification\s+([^>]*)>([\s\S]*?)<\/dcp-notification>/g)].map((m) => ({
        index: m.index!,
        end: m.index! + m[0].length,
        attrs: m[1]!,
        body: m[2]!,
      }));
    fuzz(
      ['<dcp-notification', '</dcp-notification>', ' ', '\t', '\n', '\u00a0', '\u2028', '\u200b', '>', 'a="b"', 'x', '<',
        '/', '<dcp-notificationx', '<dcp-notification a="b">', '<dcp-notification\u00a0>'],
      (text) => {
        const expected = legacy(text);
        expect(tagBlocks(text, 'dcp-notification', { attributes: 'spaced' })).toEqual(expected);
        return expected.length;
      },
    );
  });

  test('matches the legacy <file> regex, the one fileTagBlocks replaced', () => {
    const legacy = (text: string) =>
      [...text.matchAll(/<file\s+([^>]*?)>\s*[\s\S]*?<\/file>/g)].map((m) => [m.index!, m.index! + m[0].length, m[1]!]);
    fuzz(['<file', '</file>', ' ', '\t', '\n', '>', 'path="a"', 'x', '<', '<filex', '<file path="a">', '<file\t>'], (text) => {
      const expected = legacy(text);
      expect(tagBlocks(text, 'file', { attributes: 'spaced' }).map((b) => [b.index, b.end, b.attrs])).toEqual(expected);
      return expected.length;
    });
  });
});

describe('selfClosingTags: <name …/>', () => {
  const legacy = (text: string) =>
    [...text.matchAll(/<project_ref\b([\s\S]*?)\/>/g)].map((m) => ({
      index: m.index!,
      end: m.index! + m[0].length,
      attrs: m[1]!,
    }));

  test('matches the legacy regex on 3000 random strings', () => {
    fuzz(
      ['<project_ref', '<project_refs', '<project_ref_', '<project_ref1', '<project_ref-', '<project_ref/>', '/>', '/',
        '>', ' ', '\n', 'x', 'name="a"', '<', '\u00e9'],
      (text) => {
        const expected = legacy(text);
        expect(selfClosingTags(text, 'project_ref')).toEqual(expected);
        return expected.length;
      },
    );
  });

  test('a longer name is not the tag, and the tag may end the text', () => {
    expect(selfClosingTags('<project_refs x/>', 'project_ref')).toEqual([]);
    expect(selfClosingTags('<project_ref x="1"/> and <project_ref', 'project_ref')).toEqual([
      { index: 0, end: 20, attrs: ' x="1"' },
    ]);
  });
});

describe('xmlBlocks: <tag>…</tag> for any tag', () => {
  const legacy = (text: string) =>
    [...text.matchAll(/<([a-z][a-z0-9_-]*)>([\s\S]*?)<\/\1>/gi)].map((m) => ({
      index: m.index!,
      end: m.index! + m[0].length,
      tag: m[1]!,
      body: m[2]!,
    }));

  test('matches the legacy regex on 3000 random strings', () => {
    fuzz(
      ['<a>', '</a>', '<A>', '</A>', '<b>', '</b>', '<a-1>', '</a-1>', '</A-1>', '<a_b>', '</a_b>', '<ab>', '</ab>', '<1>',
        '</1>', '<>', '</>', '<a >', '</a >', '<', '>', '/', 'x', ' ', '\n', '<task_failed>', '</TASK_FAILED>',
        '<\u212A>', '<k>', '</k>', '</\u212A>'],
      (text) => {
        const expected = legacy(text);
        expect(xmlBlocks(text)).toEqual(expected);
        return expected.length;
      },
    );
  });

  test('the closing tag must repeat the name, in any case', () => {
    expect(xmlBlocks('<Task>x</TASK> <a>y</b>')).toEqual([{ index: 0, end: 14, tag: 'Task', body: 'x' }]);
  });
});

describe('referenceHeaders: the "Referenced … (…):" line the composer appends', () => {
  test('matches the legacy regex on 3000 random strings', () => {
    const legacy = (text: string) =>
      [...text.matchAll(/\n*Referenced projects \([^)]*\):\n?/g)].map((m) => ({ index: m.index!, end: m.index! + m[0].length }));
    fuzz(['\n', 'Referenced projects (', ')', ':', '):', 'x', '(', ' ', 'Referenced projects', '\r'], (text) => {
      const expected = legacy(text);
      expect(referenceHeaders(text, 'projects')).toEqual(expected);
      return expected.length;
    });
  });

  test('matches the legacy fixed-text sessions header on 3000 random strings', () => {
    const header = 'Referenced sessions (use the session_context tool to fetch details when needed):';
    const legacy = (text: string) =>
      [...text.matchAll(/\n*Referenced sessions \(use the session_context tool to fetch details when needed\):\n?/g)].map(
        (m) => ({ index: m.index!, end: m.index! + m[0].length }),
      );
    fuzz(['\n', header, 'Referenced sessions (', 'use the session_context tool to fetch details when needed', '):', ')', 'x'], (text) => {
      const expected = legacy(text);
      expect(referenceHeaders(text, 'sessions', 'use the session_context tool to fetch details when needed')).toEqual(expected);
      return expected.length;
    });
  });
});

describe('indexOfIgnoreCase folds ASCII letters only, as a regex `i` flag without `u`', () => {
  test('matches a case-insensitive regex search on 3000 random strings', () => {
    const next = random(11);
    const needles = ['<kortix_system', 'type="session-report"', 'k', 'ks', '</at>'];
    let found = 0;
    for (const text of samples(['<kortix_system', '<KORTIX_SYSTEM', 'x', '<', '\u212A', 'K', 'k', '\u017F', 's', 'S',
      'type="SESSION-report"', '</AT>', '</at'])) {
      const needle = needles[Math.floor(next() * needles.length)]!;
      const from = Math.floor(next() * (text.length + 2)) - 1;
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      re.lastIndex = Math.max(from, 0);
      const expected = re.exec(text)?.index ?? -1;
      expect(indexOfIgnoreCase(text, needle, from)).toBe(expected);
      if (expected >= 0) found++;
    }
    expect(found).toBeGreaterThan(600);
  });
});

describe('replaceSpans and removeSpans', () => {
  test('replace each span and keep the text between them', () => {
    const spans = [{ index: 2, end: 4 }, { index: 6, end: 7 }];
    expect(replaceSpans('abcdefgh', spans, (span) => `[${span.index}]`)).toBe('ab[2]ef[6]h');
    expect(removeSpans('abcdefgh', spans)).toBe('abefh');
    expect(removeSpans('abc', [])).toBe('abc');
  });
});

// The regexes took 60–90 ms at 60k characters and quadrupled per doubling
// (quadratic), so 240k took ~1 s; the header strip took 1.3 s at 60k. These
// inputs are the shapes that made them slow.
describe('every scanner is linear on the inputs that made its regex slow', () => {
  within('tagBlocks: 16k openers that never close', () => tagBlocks('<reply_context>'.repeat(16_000), 'reply_context'));
  within('tagBlocks: 17k case-folded openers and no >', () =>
    tagBlocks('<KORTIX_SYSTEM'.repeat(17_000), 'kortix_system', { attributes: 'any', ignoreCase: true }));
  within('tagBlocks: 16k closed tags', () =>
    tagBlocks('<kortix_system a>x</kortix_system>'.repeat(7_000), 'kortix_system', { attributes: 'any', ignoreCase: true }));
  within('tagBlocks: one opener, 240k whitespace, no >', () =>
    tagBlocks(`<dcp-notification${' '.repeat(240_000)}x`, 'dcp-notification', { attributes: 'spaced' }));
  within('selfClosingTags: 16k openers and no />', () => selfClosingTags('<project_ref x>'.repeat(16_000), 'project_ref'));
  within('xmlBlocks: 80k openers that never close', () => xmlBlocks('<a>'.repeat(80_000)));
  within('xmlBlocks: 30k distinct names that never close', () =>
    xmlBlocks(Array.from({ length: 30_000 }, (_, i) => `<t${i}>`).join('')));
  within('referenceHeaders: 240k newlines', () => referenceHeaders(`${'\n'.repeat(240_000)}x`, 'projects'));
  within('referenceHeaders: 11k headers whose ) is far away', () =>
    referenceHeaders(`${'Referenced projects ('.repeat(11_000)})x`, 'projects'));
  within('indexOfIgnoreCase: 18k near-misses', () => indexOfIgnoreCase('<kortix_syste'.repeat(18_000), '<kortix_system'));
});
