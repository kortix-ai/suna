import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { rejectUnknownArgs, splitHelp, takeFlags } from '../command-argv.ts';
import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';

const HELP = 'Usage: kortix demo <subcommand>\n';
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = ORIGINAL_STDOUT_WRITE;
  process.stderr.write = ORIGINAL_STDERR_WRITE;
});

describe('splitHelp', () => {
  test('a bare command prints the help and returns 2', () => {
    expect(splitHelp([], HELP)).toBe(2);
    expect(stdout).toBe(HELP);
    expect(stderr).toBe('');
  });

  test.each([[['--help']], [['-h']], [['ls', '--help']], [['ls', '--project', 'p1', '-h']]])(
    '%j prints the help and returns 0',
    (argv) => {
      expect(splitHelp(argv, HELP)).toBe(0);
      expect(stdout).toBe(HELP);
    },
  );

  test('an argv without a help flag returns null and prints nothing', () => {
    expect(splitHelp(['ls', '--project', 'p1'], HELP)).toBeNull();
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });
});

describe('rejectUnknownArgs', () => {
  test('no leftovers returns null and prints nothing', () => {
    expect(rejectUnknownArgs([], HELP)).toBeNull();
    expect(stderr).toBe('');
  });

  test('a leftover names the first one, prints the usage to stderr and returns 2', () => {
    expect(rejectUnknownArgs(['--bogus', 'extra'], HELP)).toBe(2);
    expect(stderr).toBe(`unknown option "--bogus"\n\n${HELP}`);
    expect(stdout).toBe('');
  });
});

describe('takeFlags', () => {
  const take = (rest: string[]) => ({
    host: takeFlagValue(rest, ['--host']),
    json: takeFlagBool(rest, ['--json']),
  });

  test.each([
    [['--host', 'synthetic', '--json']],
    [['--host=synthetic', '--json']],
    [['--json', '--host=synthetic']],
  ])('%j parses to the same flags', (argv) => {
    expect(takeFlags(argv, HELP, take)).toEqual({ host: 'synthetic', json: true });
    expect(stdout + stderr).toBe('');
  });

  test('absent flags parse to their defaults', () => {
    expect(takeFlags([], HELP, take)).toEqual({ host: undefined, json: false });
  });

  test('-h / --help prints the usage to stdout and returns 0', () => {
    expect(takeFlags(['--json', '-h', '--help'], HELP, take)).toBe(0);
    expect(stdout).toBe(HELP);
    expect(stderr).toBe('');
  });

  test('a flag error prints the message and the usage to stderr and returns 2', () => {
    expect(takeFlags(['--host'], HELP, take)).toBe(2);
    expect(stderr).toBe(`--host requires a value\n\n${HELP}`);
    expect(stdout).toBe('');
  });

  test('an unknown argument wins over --help, as the old per-command loops did', () => {
    expect(takeFlags(['--help', '--bogus'], HELP, take)).toBe(2);
    expect(stderr).toBe(`unknown option "--bogus"\n\n${HELP}`);
    expect(stdout).toBe('');
  });

  test('the caller argv is not mutated', () => {
    const argv = ['--host', 'synthetic'];
    takeFlags(argv, HELP, take);
    expect(argv).toEqual(['--host', 'synthetic']);
  });
});
