import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CANONICAL_SKILL, wireCodingAgents } from '../agents';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-agents-'));
  mkdirSync(join(dir, '.kortix/opencode/skills/kortix-system'), { recursive: true });
  writeFileSync(join(dir, CANONICAL_SKILL), 'canonical skill', 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('wireCodingAgents', () => {
  test('all agents → symlinks for opencode/claude/codex(.agents) + a single AGENTS.md', () => {
    const result = wireCodingAgents({
      repoRoot: dir,
      agents: ['opencode', 'claude', 'codex', 'cursor'],
      overwrite: false,
    });

    expect(result.skipped).toEqual([]);
    expect(result.written.sort()).toEqual(
      [
        '.agents → .kortix/opencode',
        '.claude → .kortix/opencode',
        '.opencode → .kortix/opencode',
        'AGENTS.md',
      ].sort(),
    );

    // Each link is a real symlink pointing straight at the OpenCode config dir.
    // codex wires `.agents` (its documented, cross-tool skills dir), not `.codex`.
    for (const link of ['.opencode', '.claude', '.agents']) {
      expect(lstatSync(join(dir, link)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dir, link))).toBe('.kortix/opencode');
      // …and it resolves all the way to the canonical skill.
      const skill = join(dir, link, 'skills/kortix-system/SKILL.md');
      expect(readFileSync(skill, 'utf8')).toBe('canonical skill');
    }

    // AGENTS.md is a real file pointing at the canonical skill, written once.
    expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain(CANONICAL_SKILL);

    // No Cursor-specific rule file — Cursor reads AGENTS.md.
    expect(existsSync(join(dir, '.cursor'))).toBe(false);
  });

  test('only wires the agents that were selected', () => {
    const result = wireCodingAgents({ repoRoot: dir, agents: ['opencode', 'claude'], overwrite: false });

    expect(result.written.sort()).toEqual(['.claude → .kortix/opencode', '.opencode → .kortix/opencode'].sort());
    // No codex/cursor selected → no .agents link, no AGENTS.md.
    expect(existsSync(join(dir, '.agents'))).toBe(false);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
  });

  test('cursor alone wires only AGENTS.md (no symlink of its own)', () => {
    const result = wireCodingAgents({ repoRoot: dir, agents: ['cursor'], overwrite: false });

    expect(result.written).toEqual(['AGENTS.md']);
    expect(existsSync(join(dir, '.opencode'))).toBe(false);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
    expect(existsSync(join(dir, '.agents'))).toBe(false);
  });

  test('preserves existing links/file without --overwrite, replaces them with it', () => {
    const agents = ['opencode', 'codex'] as const;
    expect(wireCodingAgents({ repoRoot: dir, agents, overwrite: false }).skipped).toEqual([]);

    // Re-running without overwrite leaves everything in place (all skipped).
    const second = wireCodingAgents({ repoRoot: dir, agents, overwrite: false });
    expect(second.written).toEqual([]);
    expect(second.skipped.sort()).toEqual(['.agents', '.opencode', 'AGENTS.md'].sort());

    // With overwrite the stale link/file is removed and re-created cleanly.
    const third = wireCodingAgents({ repoRoot: dir, agents, overwrite: true });
    expect(third.skipped).toEqual([]);
    expect(lstatSync(join(dir, '.opencode')).isSymbolicLink()).toBe(true);
  });
});
