import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { installAgentSkills } from '../agents';
import { applyScaffold } from '../scaffold';

let dir: string;
const CANONICAL_SKILL = '.kortix/opencode/skills/kortix-system/SKILL.md';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-agents-'));
  mkdirSync(join(dir, '.kortix/opencode/skills/kortix-system'), { recursive: true });
  writeFileSync(join(dir, CANONICAL_SKILL), 'canonical skill', 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('installAgentSkills', () => {
  test('writes regular wrapper skill files for on-demand agents', () => {
    const result = installAgentSkills({
      repoRoot: dir,
      agents: ['opencode', 'claude'],
      overwrite: false,
    });

    expect(result.skipped).toEqual([]);
    expect(result.written.sort()).toEqual([
      '.claude/skills/kortix/SKILL.md',
      '.opencode/skills/kortix/SKILL.md',
    ]);

    for (const path of result.written) {
      const abs = join(dir, path);
      const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const text = readFileSync(fd, 'utf8');
        expect(text).toContain(CANONICAL_SKILL);
        expect(text).toContain('name: kortix');
      } finally {
        closeSync(fd);
      }
    }
  });

  test('does not create symlinks in a fully wired Kortix project', () => {
    applyScaffold({ repoRoot: dir, projectName: 'No Links' });
    installAgentSkills({
      repoRoot: dir,
      agents: ['opencode', 'claude', 'codex', 'cursor'],
      overwrite: true,
    });

    expect(findSymlinks(dir)).toEqual([]);
  });
});

function findSymlinks(root: string, relPrefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      out.push(rel.split(sep).join('/'));
    } else if (stat.isDirectory()) {
      out.push(...findSymlinks(abs, rel));
    }
  }
  return out.sort();
}
