import { describe, expect, test } from 'bun:test';

import {
  foldForTest,
  jsonTail,
  hasPhrasePair,
  labelledValue,
  removeTagBlocks,
  stripEdgeSlashes,
  stripErrorPrefixes,
  stripMarkdownImages,
  stripTrailingSlashes,
  tagAttributes,
  tagBody,
  tagBodyTrimNewline,
  taskRow,
  textBetween,
  textItems,
  unwrapMarkdownLinks,
  urlError,
} from './text-scan';

/**
 * Every scanner here replaces a regex CodeQL flagged as polynomial ReDoS once
 * the code moved from apps/web into this published package (js/polynomial-redos,
 * PR #4372). Each block proves two things:
 *   1. same answer as the old regex, over seeded random strings built from the
 *      pattern's own tokens (the regex is the oracle, kept here only);
 *   2. linear time on the input CodeQL named as the slow case.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function strings(tokens: string[], count: number, maxTokens: number, seed: number): string[] {
  const next = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = '';
    const n = Math.floor(next() * maxTokens);
    for (let j = 0; j < n; j++) s += tokens[Math.floor(next() * tokens.length)];
    out.push(s);
  }
  return out;
}

/** Runs `fn` and fails when it takes longer than `ms`. */
function fast(fn: () => unknown, ms = 250): void {
  const start = performance.now();
  fn();
  expect(performance.now() - start).toBeLessThan(ms);
}

const N = 100_000;

describe('stripTrailingSlashes / stripEdgeSlashes', () => {
  const inputs = strings(['/', 'a', ' ', '\\', 'b/c'], 3000, 8, 1);
  test('matches /\\/+$/ and /^\\/+|\\/+$/g', () => {
    for (const s of inputs) {
      expect(stripTrailingSlashes(s)).toBe(s.replace(/\/+$/, ''));
      expect(stripEdgeSlashes(s)).toBe(s.replace(/^\/+|\/+$/g, ''));
    }
  });
  test('linear on many slashes followed by a non-slash', () => {
    const s = '/'.repeat(N) + 'x';
    fast(() => stripTrailingSlashes(s));
    fast(() => stripEdgeSlashes(s));
  });
});

describe('textBetween (literal open and close)', () => {
  const inputs = strings(['<path>', '</path>', 'a', '\n', '<', '>'], 3000, 8, 2);
  test('matches /<path>([\\s\\S]*?)<\\/path>/', () => {
    for (const s of inputs) {
      const m = s.match(/<path>([\s\S]*?)<\/path>/);
      expect(textBetween(s, '<path>', '</path>')).toBe(m ? m[1] : null);
    }
  });
  test('linear on repeated opens with no close', () => {
    const s = '<path>a'.repeat(N);
    fast(() => textBetween(s, '<path>', '</path>'));
  });
});

describe('tagBodyTrimNewline', () => {
  const inputs = strings(['<content>', '</content>', 'a', '\n', '\n\n'], 3000, 8, 3);
  test('matches /<content>\\n?([\\s\\S]*?)\\n?<\\/content>/', () => {
    for (const s of inputs) {
      const m = s.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
      expect(tagBodyTrimNewline(s, 'content')).toBe(m ? m[1] : null);
    }
  });
  test('linear on repeated opens with no close', () => {
    const s = '<content>a'.repeat(N);
    fast(() => tagBodyTrimNewline(s, 'content'));
  });
});

describe('tagBody / tagAttributes (open tag with attributes)', () => {
  const inputs = strings(
    ['<skill_content', '</skill_content>', '>', ' dir="x"', 'a', '\n', '<skill_content>', '='],
    4000,
    8,
    4,
  );
  test('matches /<skill_content[^>]*>([\\s\\S]*?)<\\/skill_content>/ and /<skill_content([^>]*)>/', () => {
    for (const s of inputs) {
      const body = s.match(/<skill_content[^>]*>([\s\S]*?)<\/skill_content>/);
      expect(tagBody(s, 'skill_content')).toBe(body ? body[1] : null);
      const attrs = s.match(/<skill_content([^>]*)>/);
      expect(tagAttributes(s, 'skill_content')).toBe(attrs ? attrs[1] : null);
    }
  });
  test('linear on repeated opens', () => {
    const s = '<skill_content'.repeat(N);
    fast(() => tagBody(s, 'skill_content'));
    const t = '<skill_content='.repeat(N);
    fast(() => tagAttributes(t, 'skill_content'));
  });
});

describe('removeTagBlocks', () => {
  const inputs = strings(
    ['<kortix_goal_system', '>', '</kortix_goal_system>', 'a', '\n', ' x="1"'],
    4000,
    8,
    5,
  );
  test('matches /<kortix_goal_system[^>]*>[\\s\\S]*?<\\/kortix_goal_system>/g', () => {
    for (const s of inputs) {
      expect(removeTagBlocks(s, 'kortix_goal_system')).toBe(
        s.replace(/<kortix_goal_system[^>]*>[\s\S]*?<\/kortix_goal_system>/g, ''),
      );
    }
  });
  test('linear on repeated opens', () => {
    const s = '<kortix_goal_system'.repeat(N);
    fast(() => removeTagBlocks(s, 'kortix_goal_system'));
  });
});

describe('textItems (<file>…</file>, one line each)', () => {
  const inputs = strings(['<file>', '</file>', 'a', '\n', '\r', ' ', '<'], 4000, 10, 6);
  test('matches every /<file>(.*?)<\\/file>/g capture', () => {
    for (const s of inputs) {
      const want: string[] = [];
      const re = /<file>(.*?)<\/file>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) want.push(m[1]);
      expect(textItems(s, '<file>', '</file>')).toEqual(want);
    }
  });
  test('linear on repeated opens with no close', () => {
    const s = '<file>a'.repeat(N);
    fast(() => textItems(s, '<file>', '</file>'));
  });
});

describe('jsonTail', () => {
  const inputs = strings([':', ' ', '{', '}', 'a', '\n', ': {', '}  '], 5000, 10, 7);
  test('matches /:\\s*(\\{[\\s\\S]*\\})\\s*$/', () => {
    for (const s of inputs) {
      const m = s.match(/:\s*(\{[\s\S]*\})\s*$/);
      expect(jsonTail(s)).toBe(m ? m[1] : null);
    }
  });
  test('linear on repeated `:{{`', () => {
    const s = ':{{'.repeat(N);
    fast(() => jsonTail(s));
  });
});

describe('labelledValue (Base directory: …)', () => {
  const labels = ['Base directory', 'Directory', 'Skill directory'];
  const inputs = strings(
    ['Base directory', 'directory', 'Skill Directory', ':', ' ', '\n', '\t', 'x', '/p', '\r\n'],
    6000,
    10,
    8,
  );
  test('matches /^\\s*(?:Base directory|Directory|Skill directory)\\s*:\\s*(.+?)\\s*$/im', () => {
    for (const s of inputs) {
      const m = s.match(/^\s*(?:Base directory|Directory|Skill directory)\s*:\s*(.+?)\s*$/im);
      expect(labelledValue(s, labels)).toBe(m ? m[1] : null);
    }
  });
  test('linear on a long value and on many blank lines', () => {
    fast(() => labelledValue(`directory:${'t'.repeat(N)}`, labels));
    fast(() => labelledValue('\n'.repeat(N) + 'x', labels));
  });
});

describe('taskRow (**task-id** title — status)', () => {
  const inputs = strings(
    ['**task-a1**', ' ', '—', 'x', '\t', '*', 'task-', 'b', '**', 'ses_1', '\r'],
    6000,
    10,
    9,
  );
  test('matches /\\*\\*(task-[a-z0-9]+)\\*\\*\\s+(.+?)\\s+—\\s+(\\w+)/', () => {
    for (const s of inputs) {
      const m = s.match(/\*\*(task-[a-z0-9]+)\*\*\s+(.+?)\s+—\s+(\w+)/);
      expect(taskRow(s)).toEqual(m ? { id: m[1], title: m[2], status: m[3] } : null);
    }
  });
  test('linear on a long title with no separator', () => {
    const s = `**task-0**t${'tt'.repeat(N)}`;
    fast(() => taskRow(s));
  });
});

describe('stripErrorPrefixes', () => {
  const inputs = strings(['Error:', 'error:', ' ', 'x', 'aError:', '\n', ':', 'ERROR: '], 5000, 10, 10);
  test('matches the two Error: passes of cleanErrorMessage', () => {
    for (const s of inputs) {
      expect(stripErrorPrefixes(s)).toBe(
        s.replace(/^(?:\s*Error:\s*)+/i, '').replace(/(?:\bError:\s*){2,}/gi, ''),
      );
    }
  });
  test('linear on long runs', () => {
    fast(() => stripErrorPrefixes('Error: '.repeat(N)));
    fast(() => stripErrorPrefixes('t'.repeat(N)));
  });
});

describe('hasPhrasePair (content of … with line numbers)', () => {
  const inputs = strings(['content of ', 'Content Of ', ' with line numbers', 'x', ' ', '\r', 'with'], 5000, 8, 11);
  test('matches /content of .* with line numbers/i', () => {
    for (const s of inputs) {
      expect(hasPhrasePair(s, 'content of ', ' with line numbers')).toBe(
        /content of .* with line numbers/i.test(s),
      );
    }
  });
  test('linear on many repetitions of the first phrase', () => {
    fast(() => hasPhrasePair('content of '.repeat(N), 'content of ', ' with line numbers'));
  });
});

// The tool-output audit of 2026-09-24 found three more regexes that run on
// tool output: the markdown image and link strippers in `cleanResultSnippet`,
// and the per-URL error reader in `buildScrapeFailureResults`. These blocks
// hold them to the same two proofs, with a 100 ms budget at 240k characters.
describe('stripMarkdownImages / unwrapMarkdownLinks', () => {
  const inputs = strings(['![', '[', ']', '(', ')', 'a', ' ', '\n', '![a](b)', '[t](u)', '](', 'x'], 3000, 10, 31);
  test('match their regexes', () => {
    let replaced = 0;
    for (const s of inputs) {
      const images = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
      const links = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
      expect(stripMarkdownImages(s)).toBe(images);
      expect(unwrapMarkdownLinks(s)).toBe(links);
      if (images !== s || links !== s) replaced++;
    }
    expect(replaced).toBeGreaterThan(600);
  });
  test('linear on openers that never close', () => {
    fast(() => stripMarkdownImages('![a]('.repeat(48_000)), 100);
    fast(() => unwrapMarkdownLinks('[a]('.repeat(60_000)), 100);
    fast(() => unwrapMarkdownLinks('['.repeat(240_000)), 100);
  });
});

describe('urlError', () => {
  const url = 'https://Ex.com/\u00e9';
  const inputs = strings(
    ['https://ex.com/\u00e9:', 'HTTPS://EX.COM/\u00c9', 'https://ex.com/e', ':', ' ', '\n', 'timeout', ' https://b.io', 'Http://', 'x', '  :  ', 'https://ex.com/\u017f'],
    3000,
    8,
    32,
  );
  test('matches its regex, case-folded as a non-unicode /i regex folds', () => {
    let found = 0;
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${escaped}\\s*:\\s*([^]*?)(?=\\s+https?:\\/\\/|$)`, 'i');
    for (const s of inputs) {
      const expected = s.match(re)?.[1] ?? null;
      expect(urlError(s, url)).toBe(expected);
      if (expected !== null) found++;
    }
    expect(found).toBeGreaterThan(600);
  });
  test('linear on a long whitespace run in the error', () => {
    fast(() => urlError(`https://a.io: x${' '.repeat(240_000)}y`, 'https://a.io'), 100);
  });
});

describe('fold', () => {
  test('folds a character to an ASCII letter only when a non-unicode /i regex does', () => {
    for (let code = 0; code < 0x10000; code++) {
      const ch = String.fromCharCode(code);
      const folded = foldForTest(ch);
      expect(folded.length === 1 && /[A-Z]/.test(folded)).toBe(/^[a-z]$/i.test(ch));
    }
  });
});
