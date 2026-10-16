import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const cli = resolve(import.meta.dir, '..', 'index.ts');

// Characterization of the PLAIN new-project path of `kortix init` — the
// default flow the --force path has always overshadowed: scaffold a fresh
// directory, wire the chosen agents headlessly, report, and point at `cd`.
// Black-box: the real CLI process in a real temporary cwd, flags only
// (--primary/--agents/-y), no prompts.

describe('init — the plain new-project path', () => {
  test('--primary/--agents/-y scaffold a fresh directory headlessly', () => {
    const parent = realpathSync(mkdtempSync(resolve(tmpdir(), 'kortix-init-new-')));
    const result = spawnSync(
      process.execPath,
      [cli, 'init', 'my-app', '--primary', 'codex', '--agents', 'claude,cursor', '-y', '--no-git'],
      { cwd: parent, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    const project = resolve(parent, 'my-app');
    expect(result.stdout).toContain(`Initialized Kortix project "my-app" in ${project}`);
    expect(result.stdout).toContain('Wrote ');
    expect(result.stdout).toContain('  + kortix.yaml');
    expect(result.stdout).toContain('  + .agents/skills → ../skills');
    expect(result.stdout).toContain('  + .claude/skills → ../skills');
    expect(result.stdout).toContain('  + AGENTS.md');
    expect(result.stdout).toContain('Git: skipped (--no-git)');
    expect(result.stdout).toContain('Next:\n  cd my-app');
    expect(result.stdout).toContain('get started');

    // The scaffold landed and the primary + extras are all wired.
    expect(existsSync(resolve(project, 'kortix.yaml'))).toBe(true);
    expect(readlinkSync(resolve(project, '.agents', 'skills'))).toBe('../skills');
    expect(lstatSync(resolve(project, '.claude', 'skills')).isSymbolicLink()).toBe(true);
    expect(readFileSync(resolve(project, 'AGENTS.md'), 'utf8')).toContain('This repository is a');
    // The parent dir holds ONLY the project — no stray scaffold at top level.
    expect(readdirSync(parent)).toEqual(['my-app']);
  });

  test('-y without a name is refused before anything is created', () => {
    const parent = realpathSync(mkdtempSync(resolve(tmpdir(), 'kortix-init-noname-')));
    const result = spawnSync(process.execPath, [cli, 'init', '-y'], {
      cwd: parent,
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'kortix init: a project name is required — e.g. `kortix init my-app`.',
    );
    expect(existsSync(resolve(parent, 'kortix-project'))).toBe(false);
  });

  test('--force with an explicit name is still the NEW-project path', () => {
    const parent = realpathSync(mkdtempSync(resolve(tmpdir(), 'kortix-init-force-name-')));
    const result = spawnSync(
      process.execPath,
      [cli, 'init', '--force', 'fresh', '--primary', 'codex', '-y'],
      { cwd: parent, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Initialized Kortix project "fresh" in ${resolve(parent, 'fresh')}`,
    );
    expect(result.stdout).not.toContain('Configured this Kortix project');
    // No --no-git here: the new project becomes its own repository.
    expect(result.stdout).toContain('Git: initialized (main)');
  });

  test('a non-empty target directory is refused', () => {
    const parent = realpathSync(mkdtempSync(resolve(tmpdir(), 'kortix-init-occupied-')));
    mkdirSync(resolve(parent, 'occupied'));
    writeFileSync(resolve(parent, 'occupied', 'keep.txt'), 'keep me\n');
    const result = spawnSync(
      process.execPath,
      [cli, 'init', 'occupied', '-y', '--primary', 'codex'],
      { cwd: parent, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`kortix init: "occupied" already exists and isn't empty.`);
  });
});

describe('init — the manifest version', () => {
  function init(args: string[]) {
    const parent = realpathSync(mkdtempSync(resolve(tmpdir(), 'kortix-init-version-')));
    const result = spawnSync(
      process.execPath,
      [cli, 'init', 'my-app', '--primary', 'opencode', '-y', '--no-git', ...args],
      { cwd: parent, encoding: 'utf8' },
    );
    return { result, project: resolve(parent, 'my-app') };
  }

  test('writes kortix_version 2 by default, with the OpenCode config dir', () => {
    const { result, project } = init([]);

    expect(result.status).toBe(0);
    expect(readFileSync(resolve(project, 'kortix.yaml'), 'utf8')).toMatch(/^kortix_version: 2$/m);
    expect(existsSync(resolve(project, 'harnesses', 'opencode', 'opencode.jsonc'))).toBe(true);
    expect(existsSync(resolve(project, 'extensions'))).toBe(false);
    expect(readlinkSync(resolve(project, '.opencode'))).toBe('harnesses/opencode');
  });

  test('--manifest-version 3 writes kortix_version 3 with no harness folder', () => {
    const { result, project } = init(['--manifest-version', '3']);

    expect(result.status).toBe(0);
    expect(readFileSync(resolve(project, 'kortix.yaml'), 'utf8')).toMatch(/^kortix_version: 3$/m);
    expect(existsSync(resolve(project, 'harnesses'))).toBe(false);
    expect(existsSync(resolve(project, 'extensions', 'pty', 'pty.ts'))).toBe(true);
  });

  test('--manifest-version accepts only 2 or 3', () => {
    const { result, project } = init(['--manifest-version', '4']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--manifest-version must be 2 or 3');
    expect(existsSync(project)).toBe(false);
  });
});
