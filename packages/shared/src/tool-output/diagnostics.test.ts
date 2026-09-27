import { describe, expect, test } from 'bun:test';
import { diagnosticBlocks, diagnosticLine, parseDiagnosticsFromToolOutput } from './diagnostics';
import { chooser, within } from './testing';

// The mobile diagnostics parser (tool-output-parsers.ts; web
// stores/diagnostics-store.ts and the SDK's browser store hold the same code),
// verbatim, kept ONLY as the parity oracle.
type LegacySeverity = 1 | 2 | 3 | 4;

interface LegacyDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: LegacySeverity;
  message: string;
  source?: string;
}

function legacyParseDiagnostics(output: string): Record<string, LegacyDiagnostic[]> {
  const result: Record<string, LegacyDiagnostic[]> = {};
  const tagPattern =
    /<(?:file_diagnostics|project_diagnostics)>([\s\S]*?)<\/(?:file_diagnostics|project_diagnostics)>/g;
  const allLines: string[] = [];
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagPattern.exec(output)) !== null) {
    const content = tagMatch[1].trim();
    if (!content) continue;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('...')) allLines.push(trimmed);
    }
  }
  if (allLines.length === 0) return result;

  const linePattern = /^(Error|Warn|Info|Hint):\s+(.+?):(\d+):(\d+)\s+\[([^\]]*)\](.*)$/;
  for (const line of allLines) {
    const match = linePattern.exec(line);
    if (!match) continue;
    const [, severityStr, filePath, lineStr, colStr, source, rest] = match;
    const severity: LegacySeverity =
      severityStr === 'Error' ? 1 : severityStr === 'Warn' ? 2 : severityStr === 'Hint' ? 4 : 3;

    let message = rest.trim();
    message = message.replace(/^\[\w+\]\s*/, '');
    message = message.replace(/^\([^)]*\)\s*/, '');

    const diag: LegacyDiagnostic = {
      file: filePath,
      line: Math.max(0, Number.parseInt(lineStr, 10) - 1),
      column: Math.max(0, Number.parseInt(colStr, 10) - 1),
      severity,
      message: message || `${severityStr} at ${lineStr}:${colStr}`,
      source: source || undefined,
    };
    (result[filePath] ??= []).push(diag);
  }
  return result;
}

const LS = String.fromCharCode(0x2028);

/** Runs `check` on 3000 texts from `make` and proves at least 600 of them matched. */
function fuzz(
  seed: number,
  make: (c: ReturnType<typeof chooser>) => string,
  check: (text: string) => boolean,
) {
  const c = chooser(seed);
  let matched = 0;
  for (let i = 0; i < 3000; i++) if (check(make(c))) matched++;
  expect(matched).toBeGreaterThan(600);
}

/** One of `bases` with up to three insertions from `noise`. */
function mutate(
  c: ReturnType<typeof chooser>,
  bases: readonly string[],
  noise: readonly string[],
): string {
  let text = c.pick(bases);
  for (let k = 0, n = c.pick([0, 1, 2, 3]); k < n; k++) {
    const at = Math.floor(c.next() * (text.length + 1));
    text = text.slice(0, at) + c.pick(noise) + text.slice(at);
  }
  return text;
}

const LINES = [
  'Error: src/a.ts:3:7 [ts] Cannot find name "x"',
  'Warn: /w/b.ts:10:1 [eslint] (no-unused-vars) unused',
  'Info:  c:\\\\d.ts:1:1 [] note',
  'Hint: e.ts:2:2  [x] [y] rest',
  'Error: : 1:1 [a]',
  'Error: f:g.ts:4:4 [s] m',
  // The regex's give-back: two spaces, then a colon, make the path one space.
  'Error:  :1:1 [a] m',
  'Error: a:1:1[x] m',
];

describe('the diagnostics readers return what their regexes returned', () => {
  test('diagnosticBlocks', () =>
    fuzz(
      141,
      (c) => {
        let text = c.some(['x', '\n', '</'], 2);
        for (let block = 0, n = c.pick([1, 2, 3]); block < n; block++) {
          text += c.pick([
            '<file_diagnostics>',
            '<project_diagnostics>',
            '<file_diagnostics>',
            '<file_diagnostics',
          ]);
          text += c.some(['x', '\n', '<', '</'], 3);
          text += c.pick([
            '</file_diagnostics>',
            '</project_diagnostics>',
            '</project_diagnostics>',
            '',
          ]);
        }
        return text;
      },
      (text) => {
        const expected = [
          ...text.matchAll(
            /<(?:file_diagnostics|project_diagnostics)>([\s\S]*?)<\/(?:file_diagnostics|project_diagnostics)>/g,
          ),
        ].map((m) => m[1] ?? '');
        expect(diagnosticBlocks(text)).toEqual(expected);
        return expected.length > 0;
      },
    ));

  test('diagnosticLine', () =>
    fuzz(
      142,
      (c) => mutate(c, LINES, [':', '1', ' ', '[', ']', 'x', '\r', LS, ':1:1 [', '\t', 'Error: ']),
      (line) => {
        const m = /^(Error|Warn|Info|Hint):\s+(.+?):(\d+):(\d+)\s+\[([^\]]*)\](.*)$/.exec(line);
        expect(diagnosticLine(line)).toEqual(m ? m.slice(1).map((g) => g ?? '') : null);
        return m !== null;
      },
    ));
});

describe('parseDiagnosticsFromToolOutput', () => {
  test('returns what the regex parser returned on 3000 random tool outputs', () =>
    fuzz(
      143,
      (c) => {
        let text = c.some(['Edit applied.\n', 'x', ''], 1);
        for (let block = 0, n = c.pick([1, 2]); block < n; block++) {
          text += c.pick(['<file_diagnostics>\n', '<project_diagnostics>\n', '<file_diagnostics>']);
          for (let line = 0, m = c.pick([1, 2, 3]); line < m; line++)
            text += `${mutate(c, LINES, [':', ' ', '[', ']', 'x', '...'])}\n`;
          text += c.pick(['</file_diagnostics>', '</project_diagnostics>', '']);
        }
        return text;
      },
      (text) => {
        const expected = legacyParseDiagnostics(text);
        expect(parseDiagnosticsFromToolOutput(text)).toEqual(expected);
        return Object.keys(expected).length > 0;
      },
    ));
});

describe('no diagnostics output can freeze the renderer', () => {
  within('11k diagnostics blocks that never close (240k characters)', () =>
    parseDiagnosticsFromToolOutput('<file_diagnostics>x'.repeat(12_500)),
  );
  within('a diagnostic line with 80k ":1:1 [" candidates and no "]"', () =>
    parseDiagnosticsFromToolOutput(
      `<file_diagnostics>Error: a${':1:1 ['.repeat(40_000)}</file_diagnostics>`,
    ),
  );
  within('a diagnostic line whose file holds 240k characters and no position', () =>
    parseDiagnosticsFromToolOutput(
      `<file_diagnostics>Error: ${'a:'.repeat(120_000)}</file_diagnostics>`,
    ),
  );
});
