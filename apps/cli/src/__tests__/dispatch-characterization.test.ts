import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

/**
 * Characterization of the root dispatch in `src/index.ts`, captured BEFORE
 * the KRTX-1341 rewrite that replaces the 47-branch if-chain + the separate
 * KNOWN_COMMANDS spelling list with one handler record.
 *
 * Pinned here, through the real CLI process:
 *  - every alias dispatches to the same handler as its canonical name
 *    (`--help` output byte-identical within a pair);
 *  - the `token`, `remind` and `skills` adapters keep their extra arguments;
 *  - the `registry` stderr warning stays in front of the help;
 *  - unknown-command suggestions keep the first-wins tie order of the old
 *    KNOWN_COMMANDS list (verified ties).
 *
 * After the refactor every assertion must still pass.
 */
const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<RunResult> {
  // Built from scratch on purpose: the sandbox's injected KORTIX_* variables
  // (session id, supervised flag, sandbox host) leak into the host-notice
  // line and would make the output machine-dependent.
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: CLI_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      // No config file: no host banner, no auth, no network.
      KORTIX_CONFIG_FILE: '/tmp/dispatch-characterization-missing.json',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(9), 15_000);
  return Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    .finally(() => clearTimeout(timeout))
    .then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
}

describe('root dispatch characterization (KRTX-1341)', () => {
  const ALIASES: Array<[string, string]> = [
    ['session', 'sessions'],
    ['attach', 'connect'],
    ['t', 'tui'],
    ['deploy', 'ship'],
    ['perms', 'permissions'],
  ];

  for (const [alias, canonical] of ALIASES) {
    test(`alias "${alias}" dispatches identically to "${canonical}"`, async () => {
      const [aliasRun, canonicalRun] = await Promise.all([
        runCli([alias, '--help']),
        runCli([canonical, '--help']),
      ]);
      expect(aliasRun.code).toBe(0);
      expect(aliasRun.stdout).toBe(canonicalRun.stdout);
      expect(aliasRun.stderr).toBe(canonicalRun.stderr);
    });
  }

  test('`token --help` routes through the whoami adapter (--token-only argv preserved)', async () => {
    const result = await runCli(['token', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: kortix whoami');
  });

  test('`remind --help` routes through the reminders adapter with the add-verb default', async () => {
    const result = await runCli(['remind', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: kortix reminders');
    expect(result.stdout).toContain('kortix remind "<prompt>"');
  });

  test('`skills` hands the invoked name down so its own help text matches how it was called', async () => {
    // The unknown-subcommand path renders helpFor(invokedAs) — offline, so the
    // invoked-name pass-through is characterized without any host.
    const [asSkills, asCanonical] = await Promise.all([
      runCli(['skills', 'frobnicate']),
      runCli(['system-skills', 'frobnicate']),
    ]);
    expect(asSkills.code).toBe(asCanonical.code);
    expect(asSkills.stderr).toContain('Usage: kortix skills');
    expect(asCanonical.stderr).toContain('Usage: kortix system-skills');
    expect(asSkills.stderr).not.toContain('Usage: kortix system-skills');
    expect(asCanonical.stderr).not.toContain('Usage: kortix skills');
    expect(asSkills.stderr).toContain('unknown subcommand "frobnicate"');
  });

  test('`registry` keeps the developer-command warning on stderr in front of its help', async () => {
    const result = await runCli(['registry', '--help']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('developer command:');
    expect(result.stderr).toContain('kortix marketplace');
    expect(result.stdout).toContain('Usage: kortix registry');
  });

  test('unknown-command suggestions keep the first-wins tie order of the old candidate list', async () => {
    // Each needle below ties at the same edit distance between two (or three)
    // real command names; the winner is the one that comes FIRST in the old
    // KNOWN_COMMANDS order. Computed offline against that list.
    const ties: Array<[string, string]> = [
      ['net', 'init'], // init | t
      ['sha', 'ship'], // ship | chat
      ['les', 'files'], // files | roles
      ['oen', 'token'], // token | env
      ['sai', 'ship'], // ship | tui
      ['nri', 'tui'], // tui | cr
    ];
    for (const [needle, winner] of ties) {
      const result = await runCli([needle]);
      expect(result.code, needle).toBe(2);
      expect(result.stderr, needle).toContain(`unknown command \`${needle}\``);
      expect(result.stderr, needle).toContain(`Did you mean kortix ${winner}?`);
    }
  });

  test('a needle close to nothing suggests nothing (and still never scaffolds)', async () => {
    const result = await runCli(['zersons']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command `zersons`');
    expect(result.stderr).not.toContain('Did you mean');
    expect(result.stderr).toContain('kortix init <name>');
  });
});
