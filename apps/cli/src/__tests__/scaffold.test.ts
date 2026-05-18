import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { applyScaffold } from '../scaffold';

let dir: string;

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
  test('writes the full Kortix starter into a fresh directory', () => {
    const result = applyScaffold({ repoRoot: dir, projectName: 'Hello World' });

    expect(result.written.sort()).toEqual([
      '.gitignore',
      '.kortix/Dockerfile',
      '.kortix/opencode/agents/kortix.md',
      '.kortix/opencode/opencode.jsonc',
      '.kortix/opencode/skills/kortix-system/SKILL.md',
      '.kortix/opencode/tools/show.ts',
      'README.md',
      'kortix.toml',
    ]);
    expect(result.skipped).toEqual([]);

    // Same files now exist on disk.
    expect(walk(dir)).toEqual(result.written.sort());

    // `{{projectName}}` was substituted.
    const manifest = readFileSync(join(dir, 'kortix.toml'), 'utf8');
    expect(manifest).toContain('name = "Hello World"');
    expect(manifest).not.toContain('{{projectName}}');

    // Manifest declares the .kortix/ paths explicitly — never implicit.
    expect(manifest).toContain('dockerfile = ".kortix/Dockerfile"');
    expect(manifest).toContain('config_dir = ".kortix/opencode"');

    // Sanity-check a couple of the other content files.
    expect(readFileSync(join(dir, '.kortix/opencode/agents/kortix.md'), 'utf8'))
      .toContain('You are a **Kortix general knowledge worker** for **Hello World**.');
    expect(readFileSync(join(dir, '.kortix/opencode/tools/show.ts'), 'utf8'))
      .toContain('import { tool } from "@opencode-ai/plugin"');
  });

  test('preserveExisting leaves prior files alone, fills in the rest', () => {
    // Pre-seed a file we expect to be preserved + a folder we expect
    // to be untouched.
    mkdirSync(join(dir, '.kortix/opencode/agents'), { recursive: true });
    writeFileSync(join(dir, '.kortix/opencode/agents/kortix.md'), 'CUSTOM PERSONA', 'utf8');
    writeFileSync(join(dir, 'README.md'), 'CUSTOM README', 'utf8');

    const result = applyScaffold({
      repoRoot: dir,
      projectName: 'Preserved',
      preserveExisting: true,
    });

    expect(result.skipped.sort()).toEqual(['.kortix/opencode/agents/kortix.md', 'README.md']);
    expect(result.written).toContain('kortix.toml');
    expect(result.written).toContain('.kortix/opencode/tools/show.ts');

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
