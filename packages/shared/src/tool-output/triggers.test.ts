import { describe, expect, test } from 'bun:test';
import { chooser, within } from './testing';
import { parseTriggerLines, triggerLineFields } from './triggers';

// The trigger renderers' parser (web triggers-tool.tsx, mobile
// projects-triggers.ts), verbatim, kept ONLY as the parity oracle.
type LegacyTriggerLine =
  | { raw: string }
  | {
      status: string;
      name: string;
      sourceType: 'webhook' | 'cron';
      sourceDetail: string;
      agent: string;
      lastRun: string;
    };

const LEGACY_TRIGGER_LINE =
  /^\[(\w+)]\s+(\S+)\s*\|\s*(webhook|cron):\s*(.+?)\s*\|\s*(\w+)\s*→\s*(\w+)\s*\|\s*last_run:\s*(.+)$/;

/** Every output line starting with `[`, parsed when it matches the listing shape. */
function legacyParseTriggerLines(output: string): LegacyTriggerLine[] {
  if (!output) return [];
  return output
    .split('\n')
    .filter((l) => l.trim().startsWith('['))
    .map((line) => {
      const m = line.trim().match(LEGACY_TRIGGER_LINE);
      if (!m) return { raw: line.trim() };
      return {
        status: m[1],
        name: m[2],
        sourceType: m[3] as 'webhook' | 'cron',
        sourceDetail: m[4].trim(),
        agent: m[6],
        lastRun: m[7].trim(),
      };
    });
}

const legacyFields = (line: string) => {
  const m = line.match(LEGACY_TRIGGER_LINE);
  return m ? m.slice(1).map((g) => g ?? '') : null;
};

const ARROW = String.fromCharCode(0x2192);
const CR = '\r';
const LS = String.fromCharCode(0x2028);
const ROWS = [
  `[active] daily-report | cron: 0 9 * * * | main ${ARROW} default | last_run: 2026-01-01 09:00`,
  `[paused] hook | webhook: /hooks/a | main ${ARROW} worker | last_run: never`,
  `[x] a|b | cron: * | a ${ARROW} b | last_run: x`,
  `[on] n|webhook:x|a${ARROW}b|last_run:y`,
  // Rows that reach each backtracking choice: two typed pipes inside the name,
  // an empty source detail, an empty last run, no space after the status.
  `[a] n|cron:x|webhook:y | a ${ARROW} b | last_run: z`,
  `[a] n | cron:  | a ${ARROW} b | last_run: x`,
  `[a] n | cron: x | a ${ARROW} b | last_run:`,
  `[a]n | cron: x | a ${ARROW} b | last_run: y`,
];
const NOISE = [
  '|',
  ' ',
  '\t',
  ARROW,
  'x',
  ']',
  '[',
  'cron:',
  'webhook:',
  'last_run:',
  CR,
  LS,
  `| a ${ARROW} b |`,
  '  ',
];

/** A real listing row with up to three noise insertions. */
function row(c: ReturnType<typeof chooser>): string {
  let line = c.pick(ROWS);
  for (let k = 0, n = c.pick([0, 1, 2, 3]); k < n; k++) {
    const at = Math.floor(c.next() * (line.length + 1));
    line = line.slice(0, at) + c.pick(NOISE) + line.slice(at);
  }
  return line;
}

describe('triggerLineFields', () => {
  test('reads what the regex read on 3000 random listing rows', () => {
    const c = chooser(61);
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      // Half the rows keep trailing whitespace: the reader must also match untrimmed text.
      const line = row(c).trim() + (c.next() < 0.5 ? c.some([' ', '\t', CR, LS], 2) : '');
      const expected = legacyFields(line);
      expect(triggerLineFields(line) as string[] | null).toEqual(expected);
      if (expected) found++;
    }
    expect(found).toBeGreaterThan(600);
  });
});

describe('parseTriggerLines', () => {
  test('returns what the regex parser returned on 3000 random listings', () => {
    const c = chooser(62);
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      for (let line = 0, n = c.pick([1, 2, 3, 4]); line < n; line++)
        text += `${c.pick([' ', '', 'Triggers:\n'])}${row(c)}\n`;
      const expected = legacyParseTriggerLines(text);
      expect(parseTriggerLines(text)).toEqual(expected);
      if (expected.some((line) => !('raw' in line))) parsed++;
    }
    expect(parsed).toBeGreaterThan(600);
  });

  test('reads a real listing', () => {
    expect(parseTriggerLines(`${ROWS[0]}\n[broken line`)).toEqual([
      {
        status: 'active',
        name: 'daily-report',
        sourceType: 'cron',
        sourceDetail: '0 9 * * *',
        agent: 'default',
        lastRun: '2026-01-01 09:00',
      },
      { raw: '[broken line' },
    ]);
  });
});

describe('no trigger listing can freeze the renderer', () => {
  within('a source detail holding 240k spaces', () =>
    parseTriggerLines(`[a] n | cron: x${' '.repeat(240_000)}y`),
  );
  within('a name holding 34k "|cron:x" choices', () =>
    parseTriggerLines(`[a] n${'|cron:x'.repeat(34_000)}`),
  );
  within('a source detail holding 60k pipes before a tail that fails', () =>
    parseTriggerLines(`[a] n | cron: x${' | a'.repeat(60_000)} ${ARROW} b | last_run:`),
  );
});
