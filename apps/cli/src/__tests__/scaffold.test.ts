import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { applyScaffold } from '../scaffold';

let dir: string;

const REQUIRED_BASE_PATHS = [
  '.gitignore',
  '.kortix/memory/MEMORY.md',
  '.kortix/opencode/agents/kortix.md',
  '.kortix/opencode/skills/kortix-system/SKILL.md',
  '.kortix/opencode/tools/show.ts',
  'README.md',
  'kortix.yaml',
];

const GKW_SKILL_PATHS = [
  '.kortix/opencode/skills/account-research/SKILL.md',
  '.kortix/opencode/skills/audit-support/SKILL.md',
  '.kortix/opencode/skills/content-creation/SKILL.md',
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
  test('writes the default minimal Kortix starter into a fresh directory', () => {
    const result = applyScaffold({ repoRoot: dir, projectName: 'Hello World' });

    for (const path of REQUIRED_BASE_PATHS) expect(result.written).toContain(path);
    for (const path of GKW_SKILL_PATHS) expect(result.written).not.toContain(path);
    expect(result.skipped).toEqual([]);

    expect(walk(dir)).toEqual(result.written.sort());

    const manifest = readFileSync(join(dir, 'kortix.yaml'), 'utf8');
    expect(manifest).toContain('name: "Hello World"');
    expect(manifest).not.toContain('{{projectName}}');

    expect(manifest).not.toMatch(/^sandbox:/m);
    expect(manifest).toContain('config_dir: .kortix/opencode');
    expect(manifest).toContain('claude:\n    runtime: claude');
    expect(manifest).toContain('codex:\n    runtime: codex');
    expect(manifest).toContain('pi:\n    runtime: pi');

    expect(readFileSync(join(dir, '.kortix/opencode/agents/kortix.md'), 'utf8')).toContain('Hello World');
    expect(result.written.some((p) => p.startsWith('app/'))).toBe(false);
    expect(result.written).not.toContain('.kortix/memory/overview.md');
  });

  test('general knowledge worker skills are explicit opt-in', () => {
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
    mkdirSync(join(dir, '.kortix/opencode/agents'), { recursive: true });
    writeFileSync(join(dir, '.kortix/opencode/agents/kortix.md'), 'CUSTOM PERSONA', 'utf8');
    writeFileSync(join(dir, 'README.md'), 'CUSTOM README', 'utf8');

    const result = applyScaffold({
      repoRoot: dir,
      projectName: 'Preserved',
      preserveExisting: true,
    });

    expect(result.skipped.sort()).toEqual(['.kortix/opencode/agents/kortix.md', 'README.md']);
    expect(result.written).toContain('kortix.yaml');
    expect(result.written).toContain('.kortix/memory/MEMORY.md');

    expect(readFileSync(join(dir, '.kortix/opencode/agents/kortix.md'), 'utf8')).toBe('CUSTOM PERSONA');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('CUSTOM README');
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
