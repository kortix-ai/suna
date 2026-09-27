import { beforeAll, describe, expect, test } from 'bun:test';
// The CLI argument grammar, black-box: the real CLI entry point runs as a
// process against a throwaway config. Every host is synthetic
// (127.0.0.1:9 refuses connections), so nothing here reaches a network.
//
// 1. The flag-only commands (whoami, logout, login, doctor, schema, ship,
//    uninstall) parse through takeFlags (command-argv.ts): `--flag value` and
//    `--flag=value` parse the same, and an unknown argument is rejected.
// 2. Help and argument-error output of commands moved onto splitHelp and
//    fail/missing matches the pre-change golden after example email redaction.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = resolve(import.meta.dir, '..', 'index.ts');

type CliResult = { code: number; stdout: string; stderr: string };

/** Run `kortix <args>` in its own throwaway HOME + config. */
async function runCli(args: string[]): Promise<CliResult> {
  const tmp = mkdtempSync(join(tmpdir(), 'kortix-arg-grammar-'));
  const config = join(tmp, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: 'http://127.0.0.1:9',
          token: 'tok_synthetic',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: tmp,
    KORTIX_CONFIG_FILE: config,
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const scrub = (s: string) => s.split(tmp).join('<TMP>');
    return { code, stdout: scrub(stdout), stderr: scrub(stderr) };
  } finally {
    clearTimeout(timeout);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every invocation a describe block asserts on, spawned concurrently up front. */
function runAllBeforehand(argvs: string[][]): (args: string[]) => CliResult {
  const results = new Map<string, CliResult>();
  beforeAll(async () => {
    await Promise.all(
      argvs.map(async (args) => results.set(JSON.stringify(args), await runCli(args))),
    );
  }, 120_000);
  return (args) => {
    const result = results.get(JSON.stringify(args));
    if (!result) throw new Error(`not run beforehand: ${args.join(' ')}`);
    return result;
  };
}

describe('flag-only commands accept --flag=value exactly like --flag value', () => {
  const cases: Array<{
    name: string;
    spaced: string[];
    joined: string[];
    code: number;
    out: RegExp;
  }> = [
    {
      name: 'whoami --host',
      spaced: ['whoami', '--host', 'synthetic'],
      joined: ['whoami', '--host=synthetic'],
      code: 1,
      out: /Host "synthetic" is not logged in/,
    },
    {
      name: 'token --host',
      spaced: ['token', '--host', 'synthetic'],
      joined: ['token', '--host=synthetic'],
      code: 1,
      out: /Host "synthetic" is not logged in/,
    },
    {
      name: 'logout --host',
      spaced: ['logout', '--host', 'synthetic'],
      joined: ['logout', '--host=synthetic'],
      code: 0,
      out: /Host "synthetic" already logged out/,
    },
    {
      name: 'login --host --api --token --account',
      spaced: [
        'login',
        '--host',
        'synthetic',
        '--api',
        'http://127.0.0.1:9',
        '--token',
        'tok_synthetic',
        '--account',
        'acct',
        '--no-project',
      ],
      joined: [
        'login',
        '--host=synthetic',
        '--api=http://127.0.0.1:9',
        '--token=tok_synthetic',
        '--account=acct',
        '--no-project',
      ],
      code: 1,
      out: /Invalid API key format/,
    },
    {
      name: 'doctor --host --timeout',
      spaced: ['doctor', '--host', 'synthetic', '--timeout', '5'],
      joined: ['doctor', '--host=synthetic', '--timeout=5'],
      code: 1,
      out: /not logged in/,
    },
    {
      name: 'schema --version',
      spaced: ['schema', '--version', '2', '--url'],
      joined: ['schema', '--version=2', '--url'],
      code: 0,
      out: /kortix\.v2\.schema\.json/,
    },
    {
      name: 'ship --host',
      spaced: ['ship', '--host', 'synthetic', '--dry-run'],
      joined: ['ship', '--host=synthetic', '--dry-run'],
      code: 1,
      out: /Not a Kortix project/,
    },
  ];

  const run = runAllBeforehand(cases.flatMap((c) => [c.spaced, c.joined]));

  for (const c of cases) {
    test(c.name, () => {
      const spaced = run(c.spaced);
      const joined = run(c.joined);
      expect(spaced.code).toBe(c.code);
      expect(`${spaced.stdout}${spaced.stderr}`).toMatch(c.out);
      expect(joined).toEqual(spaced);
    });
  }
});

describe('flag-only commands reject what they do not know', () => {
  const USAGE_ERROR_COMMANDS = ['whoami', 'logout', 'login', 'doctor', 'ship'];
  const run = runAllBeforehand([
    ...[...USAGE_ERROR_COMMANDS, 'uninstall'].flatMap((cmd) => [
      [cmd, '--help'],
      [cmd, '--bogus'],
    ]),
    ['schema', '--bogus'],
    ['whoami', '--host'],
  ]);

  // `kortix ship` used to prefix this one message with `kortix ship: `; it
  // now prints the same line as its siblings (the usage below names it).
  for (const cmd of USAGE_ERROR_COMMANDS) {
    test(`${cmd} --bogus exits 2 with the usage; ${cmd} --help exits 0 with the same usage`, () => {
      const help = run([cmd, '--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`Usage: kortix ${cmd} [options]`);

      const bogus = run([cmd, '--bogus']);
      expect(bogus.code).toBe(2);
      expect(bogus.stdout).toBe('');
      expect(bogus.stderr).toEndWith(`\nunknown option "--bogus"\n\n${help.stdout}`);
    });
  }

  test('uninstall --bogus keeps its marked error, exit 2 and the usage', () => {
    const help = run(['uninstall', '--help']);
    expect(help.code).toBe(0);
    const bogus = run(['uninstall', '--bogus']);
    expect(bogus.code).toBe(2);
    expect(bogus.stdout).toBe('');
    expect(bogus.stderr).toEndWith(`\n  ✗  unknown option "--bogus"\n\n${help.stdout}`);
  });

  test('schema --bogus keeps its one-line error and exit 1', () => {
    const bogus = run(['schema', '--bogus']);
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toEndWith('\n  ✗  unknown option "--bogus"\n');
  });

  test('a flag with no value names the flag', () => {
    const res = run(['whoami', '--host']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('\n--host requires a value\n\n');
  });
});

describe('help and argument errors match the pre-refactor golden output', () => {
  const golden: Array<{ args: string[]; code: number; stdout: string; stderr: string }> =
    JSON.parse(readFileSync(join(import.meta.dir, 'support', 'arg-grammar-golden.json'), 'utf8'));
  const run = runAllBeforehand(golden.map((g) => g.args));

  for (const expected of golden) {
    test(`kortix ${expected.args.join(' ')}`, () => {
      const actual = run(expected.args);
      const redactEmails = (value: string): string =>
        value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>');
      expect({
        args: expected.args,
        code: actual.code,
        stdout: redactEmails(actual.stdout),
        stderr: redactEmails(actual.stderr),
      }).toEqual(expected);
    });
  }
});
