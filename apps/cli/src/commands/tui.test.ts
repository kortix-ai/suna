import { describe, expect, test } from 'bun:test';

import { stripAnsi } from '../style.ts';
import { EXPERIMENTAL_NOTICE, type TuiDeps, parseTuiFlags, runTui, tuiChildEnv } from './tui.ts';

const CACHED = { bin: '/home/ada/.kortix/tui/1.2.3/kortix-tui', source: 'cache' as const };

interface Harness {
  deps: Partial<TuiDeps>;
  out: string[];
  err: string[];
  /** Every `(bin, env)` the launcher spawned. Empty = the TUI never ran. */
  ran: { bin: string; env: NodeJS.ProcessEnv }[];
  /** Every version it tried to download. */
  downloads: string[];
  /** Every question it asked. */
  asked: string[];
  uninstalls: number;
}

function harness(
  overrides: Partial<TuiDeps> & { exitCode?: number; answer?: boolean } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const ran: { bin: string; env: NodeJS.ProcessEnv }[] = [];
  const downloads: string[] = [];
  const asked: string[] = [];
  let uninstalls = 0;
  const { exitCode = 0, answer = true, ...rest } = overrides;
  const deps: Partial<TuiDeps> = {
    loadAuthForHost: (name) => (name === 'cloud' ? { token: 'kortix_pat_live' } : null),
    findBin: () => CACHED,
    download: async (version) => {
      downloads.push(version);
      return `/home/ada/.kortix/tui/${version}/kortix-tui`;
    },
    uninstall: () => {
      uninstalls += 1;
      return '/home/ada/.kortix/tui';
    },
    version: () => '1.2.3',
    isInteractive: () => true,
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    run: async (bin, env) => {
      ran.push({ bin, env });
      return exitCode;
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...rest,
  };
  return {
    deps,
    out,
    err,
    ran,
    downloads,
    asked,
    get uninstalls() {
      return uninstalls;
    },
  };
}

describe('kortix tui — flags', () => {
  test('parses every flag and leaves nothing behind', () => {
    expect(
      parseTuiFlags(['--host', 'cloud', '--project', 'p1', '--session', 's1', '--install']),
    ).toEqual({
      help: false,
      install: true,
      uninstall: false,
      host: 'cloud',
      project: 'p1',
      session: 's1',
    });
  });

  test('accepts the --flag=value form', () => {
    expect(parseTuiFlags(['--project=p2', '--session=s2'])).toEqual({
      help: false,
      install: false,
      uninstall: false,
      project: 'p2',
      session: 's2',
    });
  });

  test('-h and --help both ask for help; --uninstall is its own verb', () => {
    expect(parseTuiFlags(['-h']).help).toBe(true);
    expect(parseTuiFlags(['--help']).help).toBe(true);
    expect(parseTuiFlags(['--uninstall']).uninstall).toBe(true);
  });

  test('a flag with no value is an error, not a silent undefined', () => {
    expect(() => parseTuiFlags(['--project'])).toThrow('--project requires a value');
  });

  test('a bare positional is rejected — tui takes options only', () => {
    expect(() => parseTuiFlags(['abc123'])).toThrow('unexpected argument "abc123"');
    expect(() => parseTuiFlags(['--nope'])).toThrow('unknown option "--nope"');
  });
});

describe('kortix tui — the child environment', () => {
  test('the three flags travel as env, because the child is a separate process', () => {
    expect(
      tuiChildEnv({ host: 'cloud', project: 'p1', session: 's1' }, { PATH: '/usr/bin' }),
    ).toEqual({
      PATH: '/usr/bin',
      KORTIX_TUI_HOST: 'cloud',
      KORTIX_PROJECT_ID: 'p1',
      KORTIX_SESSION_ID: 's1',
    });
  });

  test('an unset flag never shadows what the shell already exported', () => {
    expect(tuiChildEnv({}, { KORTIX_PROJECT_ID: 'from-shell' })).toEqual({
      KORTIX_PROJECT_ID: 'from-shell',
    });
  });
});

describe('kortix tui — help and argument errors', () => {
  test('--help prints usage and never runs or downloads anything', async () => {
    const h = harness();
    expect(await runTui(['--help'], h.deps)).toBe(0);
    const text = stripAnsi(h.out.join(''));
    expect(text).toContain('Usage: kortix tui [options]');
    expect(text).toContain('--host <name>');
    expect(text).toContain('--install');
    expect(text).toContain('--uninstall');
    expect(text).toContain('KORTIX_TUI_BIN');
    // The separate install is the first thing a reader has to learn.
    expect(text).toContain('SEPARATE binary');
    expect(text).toContain('~/.kortix/tui/<version>/');
    expect(text).toContain('Experimental');
    expect(text).toContain('https://kortix.com/docs/tui');
    expect(h.ran).toEqual([]);
    expect(h.downloads).toEqual([]);
  });

  test('a bad flag exits 2 with the help on stderr and nothing spawned', async () => {
    const h = harness();
    expect(await runTui(['--wat'], h.deps)).toBe(2);
    expect(stripAnsi(h.err.join(''))).toContain('unknown option "--wat"');
    expect(stripAnsi(h.err.join(''))).toContain('Usage: kortix tui');
    expect(h.ran).toEqual([]);
  });
});

describe('kortix tui — launching the installed binary', () => {
  test('the cached binary runs with the flags in its environment', async () => {
    const h = harness();
    expect(await runTui(['--project', 'p9', '--session', 's9'], h.deps)).toBe(0);
    expect(h.ran).toHaveLength(1);
    expect(h.ran[0]?.bin).toBe(CACHED.bin);
    expect(h.ran[0]?.env.KORTIX_PROJECT_ID).toBe('p9');
    expect(h.ran[0]?.env.KORTIX_SESSION_ID).toBe('s9');
    expect(h.downloads).toEqual([]);
  });

  test('the experimental notice reaches stderr before the TUI takes the screen', async () => {
    const seen: string[] = [];
    const h = harness();
    const deps: Partial<TuiDeps> = {
      ...h.deps,
      stderr: (text) => seen.push(`stderr:${text.trim()}`),
      run: async () => {
        seen.push('run');
        return 0;
      },
    };
    expect(await runTui([], deps)).toBe(0);
    expect(seen).toEqual([`stderr:${EXPERIMENTAL_NOTICE}`, 'run']);
    expect(EXPERIMENTAL_NOTICE).toBe(
      'kortix tui is experimental — keys: ? · docs: https://kortix.com/docs/tui',
    );
  });

  test("the command's exit code is the child's exit code", async () => {
    const h = harness({ exitCode: 7 });
    expect(await runTui([], h.deps)).toBe(7);
  });

  test('--host is validated by the CLI and passed on by name', async () => {
    const h = harness();
    expect(await runTui(['--host', 'cloud'], h.deps)).toBe(0);
    expect(h.ran[0]?.env.KORTIX_TUI_HOST).toBe('cloud');
  });

  test("--host names an unknown host → exit 1 with the CLI's standard message", async () => {
    const h = harness();
    expect(await runTui(['--host', 'ghost'], h.deps)).toBe(1);
    expect(stripAnsi(h.err.join(''))).toContain('Host "ghost" is not logged in.');
    expect(stripAnsi(h.err.join(''))).toContain('kortix hosts login ghost');
    expect(h.ran).toEqual([]);
    expect(h.downloads).toEqual([]);
  });
});

describe('kortix tui — first run installs the binary', () => {
  test('on a terminal it asks, then downloads and runs', async () => {
    const h = harness({ findBin: () => null });
    expect(await runTui([], h.deps)).toBe(0);
    expect(h.asked).toEqual([
      expect.stringContaining('kortix tui is experimental and installs separately'),
    ]);
    expect(h.asked[0]).toContain('1.2.3');
    expect(h.downloads).toEqual(['1.2.3']);
    expect(h.ran[0]?.bin).toBe('/home/ada/.kortix/tui/1.2.3/kortix-tui');
  });

  test('answering no installs nothing, runs nothing, and exits 0', async () => {
    const h = harness({ findBin: () => null, answer: false });
    expect(await runTui([], h.deps)).toBe(0);
    expect(h.downloads).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(stripAnsi(h.out.join(''))).toContain('kortix tui --install');
  });

  test('off a terminal it never starts an 80 MB download — exit 2 with the remedy', async () => {
    const h = harness({ findBin: () => null, isInteractive: () => false });
    expect(await runTui([], h.deps)).toBe(2);
    const text = stripAnsi(h.err.join(''));
    expect(text).toContain('which is not installed');
    expect(text).toContain('kortix tui --install');
    expect(h.asked).toEqual([]);
    expect(h.downloads).toEqual([]);
    expect(h.ran).toEqual([]);
  });

  test('--install downloads without asking and does NOT take the terminal', async () => {
    const h = harness({ findBin: () => null, isInteractive: () => false });
    expect(await runTui(['--install'], h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.downloads).toEqual(['1.2.3']);
    expect(h.ran).toEqual([]);
    expect(stripAnsi(h.out.join(''))).toContain('installed kortix-tui v1.2.3');
  });

  test('--install with the binary already there reports it and downloads nothing', async () => {
    const h = harness();
    expect(await runTui(['--install'], h.deps)).toBe(0);
    expect(h.downloads).toEqual([]);
    expect(stripAnsi(h.out.join(''))).toContain('already installed');
    expect(stripAnsi(h.out.join(''))).toContain(CACHED.bin);
  });

  test('a failed download exits 1 and says how to build one instead', async () => {
    const h = harness({
      findBin: () => null,
      download: async () => {
        throw new Error('checksum mismatch for kortix-tui-darwin-arm64');
      },
    });
    expect(await runTui(['--install'], h.deps)).toBe(1);
    const text = stripAnsi(h.err.join(''));
    expect(text).toContain('Could not install kortix-tui v1.2.3: checksum mismatch');
    expect(text).toContain('pnpm --filter @kortix/tui bundle');
    expect(text).toContain('KORTIX_TUI_BIN');
    expect(h.ran).toEqual([]);
  });

  test('a source build says "dev", never "vdev"', async () => {
    const h = harness({ version: () => 'dev' });
    expect(await runTui(['--install'], h.deps)).toBe(0);
    const text = stripAnsi(h.out.join(''));
    expect(text).toContain('kortix-tui dev is already installed');
    expect(text).not.toContain('vdev');
  });

  test('a source build (version "dev") never invents a release URL', async () => {
    const h = harness({ findBin: () => null, version: () => 'dev' });
    expect(await runTui([], h.deps)).toBe(1);
    const text = stripAnsi(h.err.join(''));
    expect(text).toContain('No kortix-tui binary for this build.');
    expect(text).toContain('pnpm --filter @kortix/tui bundle');
    expect(text).toContain('KORTIX_TUI_BIN=');
    // And it says where to drop one so `kortix tui` works with no env var.
    expect(text).toContain('/.kortix/tui/dev/kortix-tui');
    expect(h.downloads).toEqual([]);
    expect(h.asked).toEqual([]);
  });
});

describe('kortix tui — uninstall', () => {
  test('--uninstall removes the managed directory and runs nothing', async () => {
    const h = harness();
    expect(await runTui(['--uninstall'], h.deps)).toBe(0);
    expect(h.uninstalls).toBe(1);
    expect(stripAnsi(h.out.join(''))).toContain('removed /home/ada/.kortix/tui');
    expect(h.ran).toEqual([]);
  });
});
