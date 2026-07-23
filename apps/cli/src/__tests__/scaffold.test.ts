import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { applyScaffold } from '../scaffold';

let dir: string;

const REQUIRED_BASE_PATHS = [
  '.gitignore',
  '.kortix/memory/MEMORY.md',
  '.opencode/agents/kortix.md',
  '.opencode/skills/kortix-system/SKILL.md',
  '.opencode/tools/show.ts',
  'README.md',
  'kortix.yaml',
];

const GKW_SKILL_PATHS = [
  '.opencode/skills/account-research/SKILL.md',
  '.opencode/skills/deep-research/SKILL.md',
  '.opencode/skills/pdf/SKILL.md',
];

function baseStarterPaths(): string[] {
  const probe = mkdtempSync(join(tmpdir(), 'kortix-scaffold-base-'));
  try {
    return applyScaffold({ repoRoot: probe, projectName: 'Base', template: 'minimal' }).written.sort();
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-scaffold-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function walk(root: string, relPrefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel.split(sep).join('/'));
  }
  return out.sort();
}

describe('applyScaffold', () => {
  test('writes the default (full) Kortix starter into a fresh directory', () => {
    const result = applyScaffold({ repoRoot: dir, projectName: 'Hello World' });

    // The one starter kit is the default — the full skill kit ships with it.
    for (const path of REQUIRED_BASE_PATHS) expect(result.written).toContain(path);
    for (const path of GKW_SKILL_PATHS) expect(result.written).toContain(path);
    expect(result.skipped).toEqual([]);

    expect(walk(dir)).toEqual(result.written.sort());

    const manifest = readFileSync(join(dir, 'kortix.yaml'), 'utf8');
    expect(manifest).toContain('name: "Hello World"');
    expect(manifest).not.toContain('{{projectName}}');

    expect(manifest).not.toMatch(/^sandbox:/m);
    expect(manifest).toContain('config_dir: .opencode');
    // OpenCode remains the default. Every official harness is selectable.
    expect(manifest).toContain('kortix:\n    runtime: opencode');
    expect(manifest).toContain('claude:\n    runtime: claude');
    expect(manifest).toContain('codex:\n    runtime: codex');
    expect(manifest).toContain('pi:\n    runtime: pi');

    expect(readFileSync(join(dir, '.opencode/agents/kortix.md'), 'utf8')).toContain('Hello World');
    expect(result.written.some((p) => p.startsWith('app/'))).toBe(false);
    expect(result.written).not.toContain('.kortix/memory/overview.md');
  });

  test('general-knowledge-worker template carries the full domain skill kit', () => {
    const result = applyScaffold({
      repoRoot: dir,
      projectName: 'Hello World',
      template: 'general-knowledge-worker',
    });

    for (const path of REQUIRED_BASE_PATHS) expect(result.written).toContain(path);
    for (const path of GKW_SKILL_PATHS) expect(result.written).toContain(path);
  });

  test('minimal template writes only the shared Kortix starter', () => {
    const base = baseStarterPaths();
    const result = applyScaffold({ repoRoot: dir, projectName: 'Minimal', template: 'minimal' });

    expect(result.written.sort()).toEqual(base);
    for (const path of REQUIRED_BASE_PATHS) expect(result.written).toContain(path);
    for (const path of GKW_SKILL_PATHS) expect(result.written).not.toContain(path);
    expect(walk(dir)).toEqual(base);
  });

  test('preserveExisting leaves prior files alone, fills in the rest', () => {
    // Pre-seed shipped files we expect to be preserved.
    mkdirSync(join(dir, '.opencode/agents'), { recursive: true });
    writeFileSync(join(dir, '.opencode/agents/kortix.md'), 'CUSTOM PERSONA', 'utf8');
    writeFileSync(join(dir, 'README.md'), 'CUSTOM README', 'utf8');

    const result = applyScaffold({
      repoRoot: dir,
      projectName: 'Preserved',
      preserveExisting: true,
    });

    expect(result.skipped.sort()).toEqual(['.opencode/agents/kortix.md', 'README.md']);
    expect(result.written).toContain('kortix.yaml');
    expect(result.written).toContain('.kortix/memory/MEMORY.md');

    expect(readFileSync(join(dir, '.opencode/agents/kortix.md'), 'utf8')).toBe('CUSTOM PERSONA');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('CUSTOM README');
  });

  test('clears a legacy .opencode symlink before writing, even when the un-migrated target still exists', () => {
    // A pre-1.x scaffold left `.opencode` → `.kortix/opencode`. Whether or not
    // the legacy target dir is still there, `applyScaffold` is about to write
    // a real `.opencode` tree here and must supersede the compat link, not
    // write through it (writing through a dangling one throws ENOENT; writing
    // through a live one would silently land files in `.kortix/opencode`
    // instead of creating the canonical real dir scaffold is supposed to own).
    mkdirSync(join(dir, '.kortix/opencode'), { recursive: true });
    symlinkSync('.kortix/opencode', join(dir, '.opencode'));

    const result = applyScaffold({ repoRoot: dir, projectName: 'Cleared', template: 'minimal' });

    expect(lstatSync(join(dir, '.opencode')).isSymbolicLink()).toBe(false);
    expect(statSync(join(dir, '.opencode')).isDirectory()).toBe(true);
    expect(result.written).toContain('.opencode/agents/kortix.md');
    expect(
      readFileSync(join(dir, '.opencode/agents/kortix.md'), 'utf8'),
    ).toContain('Cleared');
  });

  test('clears a DANGLING legacy .opencode symlink before writing (no target at all)', () => {
    symlinkSync('.kortix/opencode', join(dir, '.opencode'));

    const result = applyScaffold({ repoRoot: dir, projectName: 'Cleared', template: 'minimal' });

    expect(lstatSync(join(dir, '.opencode')).isSymbolicLink()).toBe(false);
    expect(result.written).toContain('.opencode/agents/kortix.md');
  });

  test('a custom .opencode symlink to some other target is left alone by applyScaffold', () => {
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });
    symlinkSync('elsewhere', join(dir, '.opencode'));

    // Not our legacy target — applyScaffold must not touch the symlink. It
    // still writes the starter's `.opencode/*` files through it transparently
    // (they land inside `elsewhere/`), exactly as they would for any real
    // directory at that path; the point of this test is only that the
    // symlink itself survives, untouched.
    applyScaffold({ repoRoot: dir, projectName: 'X', template: 'minimal' });
    expect(lstatSync(join(dir, '.opencode')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, '.opencode'))).toBe('elsewhere');
    expect(existsSync(join(dir, 'elsewhere/agents/kortix.md'))).toBe(true);
  });

  test('without preserveExisting, overwrites prior files', () => {
    writeFileSync(join(dir, 'README.md'), 'CUSTOM README', 'utf8');

    const result = applyScaffold({ repoRoot: dir, projectName: 'Overwrite' });

    expect(result.skipped).toEqual([]);
    expect(result.written).toContain('README.md');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).not.toBe('CUSTOM README');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('Overwrite');
  });
});
