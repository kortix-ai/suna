import { describe, expect, test } from 'bun:test';
import { parseSessionSearchHits, searchHitRow } from './session-search';
import { chooser, within } from './testing';

// The session_search renderers' parser (web session-search-tool.tsx, mobile
// agents-session.ts), verbatim, and its row regex, kept ONLY as parity oracles.
interface LegacySearchHit {
  id: string;
  title: string;
  updated: string;
  score: string;
  snippet: string;
}

function legacyParseSessionSearchHits(output: string): LegacySearchHit[] {
  if (!output) return [];
  const results: LegacySearchHit[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(ses_\S+)\s*\|\s*"([^"]*)"\s*\|\s*(\S+.*?)\s*\|\s*score=(\d+)/);
    if (m) {
      const snippetLine = lines[i + 1]?.match(/^Snippet:\s*(.+)/);
      results.push({
        id: m[1],
        title: m[2],
        updated: m[3].trim(),
        score: m[4],
        snippet: snippetLine?.[1]?.trim() || '',
      });
    }
  }
  return results;
}

function legacyRow(line: string): [string, string, string, string] | null {
  const m = line.match(/^(ses_\S+)\s*\|\s*"([^"]*)"\s*\|\s*(\S+.*?)\s*\|\s*score=(\d+)/);
  return m ? [m[1] ?? '', m[2] ?? '', m[3] ?? '', m[4] ?? ''] : null;
}

const CR = '\r';
const LS = String.fromCharCode(0x2028);

describe('searchHitRow', () => {
  test('reads what the regex read on 3000 random result lines', () => {
    const { next, pick } = chooser(51);
    const rows = [
      'ses_abc | "Fix build" | 2026-01-01 12:00 | score=12',
      'ses_a|"t"|x|score=1',
      'ses_x | "a|b" | d | score=7',
      'ses_q|"t"|"u"|v | score=3',
      'ses_z | "t" | x y z |  score=40',
    ];
    const noise = ['|', '"', ' ', '\t', CR, LS, 'x', '| score=5', 'score=', '|"z"|', '  ', 'ses_'];
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      // A real row with up to three noise insertions: each moves a choice point of the regex.
      let line = pick(rows);
      for (let k = 0, n = pick([0, 1, 2, 3]); k < n; k++) {
        const at = Math.floor(next() * (line.length + 1));
        line = line.slice(0, at) + pick(noise) + line.slice(at);
      }
      const expected = legacyRow(line);
      expect(searchHitRow(line)).toEqual(expected);
      if (expected) found++;
    }
    expect(found).toBeGreaterThan(600);
  });
});

describe('parseSessionSearchHits', () => {
  test('returns what the regex parser returned on 3000 random search outputs', () => {
    const { pick, some } = chooser(52);
    const rows = [
      'ses_abc | "Fix the build" | 2026-01-01 12:00 | score=12',
      'ses_def|"Deploy"|2026-01-02|score=3',
      'ses_x | "a|b" | today | score=1',
      'Snippet: the build failed on step 3',
      'Snippet:   ',
      'ses_bad | no quotes | x | score=1',
      'Found 2 sessions',
      '',
    ];
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      for (let line = 0, n = pick([1, 2, 3, 4, 5]); line < n; line++)
        text += pick(rows) + some([' ', CR], 1) + '\n';
      const expected = legacyParseSessionSearchHits(text);
      expect(parseSessionSearchHits(text)).toEqual(expected);
      if (expected.length > 0) found++;
    }
    expect(found).toBeGreaterThan(600);
  });

  test('reads a real result list', () => {
    const output =
      'ses_abc | "Fix the build" | 2026-01-01 12:00 | score=12\nSnippet: the build failed\n';
    expect(parseSessionSearchHits(output)).toEqual([
      {
        id: 'ses_abc',
        title: 'Fix the build',
        updated: '2026-01-01 12:00',
        score: '12',
        snippet: 'the build failed',
      },
    ]);
  });
});

describe('no search output can freeze the renderer', () => {
  within('a row whose date alternates 120k words and spaces, with no score', () =>
    parseSessionSearchHits(`ses_a | "t" | ${'x '.repeat(120_000)}`),
  );
  within('a row whose date holds 240k characters with no whitespace and no score', () =>
    parseSessionSearchHits(`ses_a | "t" | ${'x'.repeat(240_000)}`),
  );
  within('a row whose id holds 60k "|"t"|" choices', () =>
    parseSessionSearchHits(`ses_${'|"t"|'.repeat(48_000)}`),
  );
  within('a row whose id holds 48k "|"t"|" choices and a score label with no digits', () =>
    parseSessionSearchHits(`ses_${'|"t"|'.repeat(48_000)}score=x`),
  );
  within('a row whose date holds 240k characters and a score label with no digits', () =>
    parseSessionSearchHits(`ses_a | "t" | ${'x'.repeat(240_000)} | score=x`),
  );
  within('a row whose date holds 80k pipes and no score', () =>
    parseSessionSearchHits(`ses_a | "t" | x${' |x'.repeat(80_000)}`),
  );
});
