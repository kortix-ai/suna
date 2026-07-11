import { describe, expect, test } from 'bun:test';

import { formatHelp, help, stripAnsi } from '../style.ts';

const SAMPLE = `Usage: kortix demo <subcommand> [options]

Do a demo thing. Run \`kortix ship\` to apply.

Subcommands:
  ls               List things.
  set KEY=VALUE    Upsert a thing. Wraps
                   to a second line.

Global options:
  --project <id>   Operate on this project id.
  -h, --help       Show this help.
`;

describe('formatHelp', () => {
  const out = stripAnsi(formatHelp(SAMPLE));

  test('keeps the Usage line contiguous so `toContain` assertions survive', () => {
    // ANSI is inserted between "Usage:" and the command, but it must remain a
    // single readable string once codes are stripped (as in non-TTY runs).
    expect(out).toContain('Usage: kortix demo');
  });

  test('preserves every section header and description verbatim', () => {
    for (const fragment of [
      'Subcommands:',
      'Global options:',
      'Do a demo thing.',
      'List things.',
      'Upsert a thing. Wraps',
      'to a second line.',
      '--project <id>',
    ]) {
      expect(out).toContain(fragment);
    }
  });

  test('draws a rule under the title', () => {
    expect(out).toContain('─');
  });

  test('collapses doubled blank lines (no triple newlines)', () => {
    expect(out).not.toContain('\n\n\n');
  });

  test('an author-indented list item keeps its indent (no double-indent)', () => {
    // A step with no 2-space gap falls to the prose branch; it must NOT get a
    // second 2-space base bolted onto its existing indent (regression: it used
    // to render at col 4 while its 2-space-gap siblings stayed at col 2).
    const listed = stripAnsi(
      formatHelp('Usage: kortix x\n\nSteps:\n  1. first thing happens here\n  2. second\n'),
    );
    expect(listed).toContain('\n  1. first thing happens here');
    expect(listed).not.toContain('\n    1. first thing happens here');
  });

  test('degrades to plain text under non-TTY (no escape codes leak)', () => {
    // In the test runner stdout is not a TTY, so formatHelp must already be
    // ANSI-free — stripAnsi is then a no-op.
    expect(formatHelp(SAMPLE)).toBe(out);
  });
});

describe('help tagged template', () => {
  test('applies formatHelp and interpolates values', () => {
    const providers = ['pipedream', 'mcp'];
    const rendered = stripAnsi(help`Usage: kortix x <sub>

Providers: ${providers.join('|')}
`);
    expect(rendered).toContain('Usage: kortix x');
    expect(rendered).toContain('Providers: pipedream|mcp');
  });
});
