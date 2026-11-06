import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printGetStarted } from '../banner';
import { runGit } from '../git-run';
import { setScalarInArrayBlock, setTableScalar, setYamlMapEntry } from '../manifest-edit';
import { convertLocalLegacy, localLegacyManifest } from '../manifest-legacy';
import { configureProjectGitAuth } from '../project-git';
import { C, stripAnsi } from '../style';
import { renderUpdateBox } from '../update-check';

const { faded: FADED, bold: BOLD, reset: RESET, yellow: YELLOW, cyan: CYAN } = C;

// Pins current behavior of the CLI core helpers that KRTX-4328 deduplicates:
// the YAML scalar splice, the box frame, the git runners, the repo walker.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-core-char-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MANIFEST = [
  '# top comment',
  'kortix_version: 3',
  'policy:',
  '  mode: ask # trailing',
  '  other: 1',
  '',
  'triggers:',
  '  # nightly job',
  '  - slug: nightly',
  '    cron: "0 0 * * *" # when',
  '    enabled: true',
  '',
].join('\n');

describe('manifest-edit scalar splice', () => {
  // `writeManifest` runs `fixManifestText`, which drops the `kortix_version: 3` line.
  const FIXED = MANIFEST.replace('kortix_version: 3\n', '');
  const edit = (run: (file: string) => void): string => {
    const file = join(dir, 'kortix.yaml');
    writeFileSync(file, MANIFEST);
    run(file);
    return readFileSync(file, 'utf8');
  };

  test('setScalarInArrayBlock replaces an existing scalar in place, keeping every comment', () => {
    const out = edit(() =>
      expect(setScalarInArrayBlock('triggers', 'slug', 'nightly', 'cron', '5 4 * * *', dir)).toBe(
        true,
      ),
    );
    expect(out).toBe(FIXED.replace('"0 0 * * *"', '5 4 * * *'));
  });

  test('setScalarInArrayBlock adds a missing key through the document', () => {
    const out = edit(() =>
      expect(setScalarInArrayBlock('triggers', 'slug', 'nightly', 'timezone', 'UTC', dir)).toBe(
        true,
      ),
    );
    expect(out).toBe(
      FIXED.replace('    enabled: true\n', '    enabled: true\n    timezone: UTC\n'),
    );
  });

  test('setTableScalar replaces a value in place and appends a key after the last entry', () => {
    const out = edit(() => {
      setTableScalar('policy', 'mode', 'auto', dir);
      setTableScalar('policy', 'extra', true, dir);
    });
    expect(out).toBe(
      FIXED.replace('ask', 'auto').replace('  other: 1\n', '  other: 1\n  extra: true\n'),
    );
  });

  test('setYamlMapEntry replaces (dropping the old trailing comment), adds and creates', () => {
    const results: string[] = [];
    const out = edit((file) => {
      results.push(setYamlMapEntry(file, 'policy', 'mode', 'auto', 'why'));
      results.push(setYamlMapEntry(file, 'policy', 'extra', 'x y: z'));
      results.push(setYamlMapEntry(file, 'fresh', 'k', 'v', 'c'));
    });
    expect(results).toEqual(['replaced', 'added', 'created']);
    const edited = FIXED.replace('ask # trailing', 'auto  # why').replace(
      '  other: 1\n',
      '  other: 1\n  extra: "x y: z"\n',
    );
    expect(out).toBe(`${edited}\nfresh:\n  k: v  # c\n`);
  });
});

describe('box frames', () => {
  test('printGetStarted draws the 70-wide faded frame, title centred', () => {
    const written = spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output = '';
    try {
      printGetStarted({ prompt: 'configure it' });
      output = written.mock.calls.map(([chunk]) => String(chunk)).join('');
    } finally {
      written.mockRestore();
    }
    const lines = output.split('\n');
    expect(lines[1]).toBe(
      `${FADED}╔${'═'.repeat(29)}${RESET}${BOLD} get started ${RESET}${FADED}${'═'.repeat(30)}╗${RESET}`,
    );
    const plain = lines.map(stripAnsi);
    expect(plain[2]).toBe(`║${' '.repeat(72)}║`);
    expect(plain[3]).toBe(
      `║ Paste this prompt into your coding agent of choice${' '.repeat(20)} ║`,
    );
    expect(plain.at(-3)).toBe(`╚${'═'.repeat(72)}╝`);
    expect(lines.at(-3)).toBe(`${FADED}╚${'═'.repeat(72)}╝${RESET}`);
    expect(lines[2]).toBe(`${FADED}║${RESET} ${' '.repeat(70)} ${FADED}║${RESET}`);
  });

  test('renderUpdateBox draws the 52-wide frame with its 2-space indent', () => {
    const box = renderUpdateBox({ current: '0.1.0', latestTag: 'v0.2.0', latestDisplay: 'v0.2.0' });
    const lines = box.split('\n');
    expect(lines[1]).toBe(
      `  ${YELLOW}╔══${RESET}${BOLD} update available ${RESET}${YELLOW}${'═'.repeat(34)}╗${RESET}`,
    );
    expect(lines[4]).toBe(`  ${YELLOW}╚${'═'.repeat(54)}╝${RESET}`);
    expect(lines[3]).toBe(
      `  ${YELLOW}║${RESET} Run  ${CYAN}kortix update${RESET}  to upgrade.${' '.repeat(21)} ${YELLOW}║${RESET}`,
    );
    expect(box).toBe(
      [
        '',
        `  ╔══ update available ${'═'.repeat(34)}╗`,
        `  ║ Kortix CLI v0.1.0  →  v0.2.0${' '.repeat(24)} ║`,
        `  ║ Run  kortix update  to upgrade.${' '.repeat(21)} ║`,
        `  ╚${'═'.repeat(54)}╝`,
      ].join('\n'),
    );
  });
});

describe('configureProjectGitAuth', () => {
  test('writes the reset helper, the helper command and useHttpPath into the local config', () => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    configureProjectGitAuth(dir, 'https://example.test/v1/git/p.git/', '!helper-cmd');
    const key = 'credential.https://example.test/v1/git/p.git.helper';
    const got = spawnSync('git', ['config', '--local', '--get-all', key], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(got.stdout).toBe('\n!helper-cmd\n');
    const path = spawnSync('git', ['config', '--local', 'credential.useHttpPath'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(path.stdout.trim()).toBe('true');
  });

  test('throws git’s stderr when the directory is not a repository', () => {
    expect(() =>
      configureProjectGitAuth(join(dir, 'missing'), 'https://example.test/x.git', '!h'),
    ).toThrow();
  });
});

describe('legacy repo walker', () => {
  test('lists repo-relative files, skipping .git and node_modules entries of any kind', () => {
    writeFileSync(join(dir, 'kortix.toml'), 'kortix_version = 1\n');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'a.md'), 'x');
    writeFileSync(join(dir, '.git'), 'gitdir: elsewhere');
    mkdirSync(join(dir, 'agents'));
    writeFileSync(join(dir, 'agents', 'a.md'), 'x');
    const legacy = localLegacyManifest(dir);
    expect(legacy).not.toBeNull();
    if (!legacy) return;
    expect(
      JSON.stringify(convertLocalLegacy(dir, legacy)).match(/node_modules|\.git\b/g) ?? [],
    ).toEqual([]);
  });
});

describe('runGit maxBuffer', () => {
  test('keeps the node default 1 MiB cap when no maxBuffer is passed, and honors an explicit one', () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const dir = mkdtempSync(join(tmpdir(), 'rungit-'));
    try {
      writeFileSync(join(dir, 'big.txt'), big);
      expect(runGit(dir, ['init', '-q']).ok).toBe(true);
      const blob = runGit(dir, ['hash-object', '-w', 'big.txt']).stdout.trim();
      expect(runGit(dir, ['cat-file', '-p', blob]).ok).toBe(false);
      const wide = runGit(dir, ['cat-file', '-p', blob], { maxBuffer: 8 * 1024 * 1024 });
      expect(wide.stdout.length).toBe(big.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
