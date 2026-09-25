import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { CANONICAL_SKILL, wireCodingAgents } from '../agents';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-agents-'));
  // Derived from CANONICAL_SKILL, never spelled out — the fixture must follow
  // the constant wherever it points.
  mkdirSync(join(dir, CANONICAL_SKILL, '..'), { recursive: true });
  mkdirSync(join(dir, 'agents'), { recursive: true });
  mkdirSync(join(dir, 'harnesses', 'opencode', 'commands'), { recursive: true });
  writeFileSync(join(dir, CANONICAL_SKILL), 'canonical skill', 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('wireCodingAgents', () => {
  test('all agents → native discovery links for opencode/claude/codex/pi + one AGENTS.md', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    mkdirSync(join(dir, '.pi'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'CLAUDE.md'), 'claude runtime', 'utf8');
    writeFileSync(join(dir, '.pi', 'README.md'), 'pi runtime', 'utf8');

    const result = wireCodingAgents({
      repoRoot: dir,
      agents: ['opencode', 'claude', 'codex', 'pi', 'cursor'],
      overwrite: false,
    });

    expect(result.skipped).toEqual([]);
    expect(result.written.sort()).toEqual(
      [
        '.agents/skills → ../skills',
        '.claude/agents → ../agents',
        '.claude/commands → ../harnesses/opencode/commands',
        '.claude/skills → ../skills',
        '.opencode → harnesses/opencode',
        '.pi/skills → ../skills',
        'AGENTS.md',
      ].sort(),
    );

    // OpenCode reads its config dir; OpenCode and Codex read `.agents/skills`.
    expect(readlinkSync(join(dir, '.opencode'))).toBe('harnesses/opencode');
    expect(lstatSync(join(dir, '.agents')).isDirectory()).toBe(true);
    expect(readlinkSync(join(dir, '.agents', 'skills'))).toBe('../skills');
    expect(readFileSync(join(dir, '.agents', CANONICAL_SKILL), 'utf8')).toBe('canonical skill');

    // Claude Code and Pi keep their runtime files and receive native links.
    expect(readFileSync(join(dir, '.claude', 'CLAUDE.md'), 'utf8')).toBe('claude runtime');
    expect(readFileSync(join(dir, '.pi', 'README.md'), 'utf8')).toBe('pi runtime');
    expect(readlinkSync(join(dir, '.claude', 'skills'))).toBe('../skills');
    expect(readlinkSync(join(dir, '.claude', 'agents'))).toBe('../agents');
    expect(readlinkSync(join(dir, '.claude', 'commands'))).toBe('../harnesses/opencode/commands');
    expect(readlinkSync(join(dir, '.pi', 'skills'))).toBe('../skills');
    expect(readFileSync(join(dir, '.claude', 'skills', 'kortix-cli', 'SKILL.md'), 'utf8')).toBe(
      'canonical skill',
    );
    expect(readFileSync(join(dir, '.pi', 'skills', 'kortix-cli', 'SKILL.md'), 'utf8')).toBe(
      'canonical skill',
    );

    // AGENTS.md is a real file pointing at the canonical skill, written once.
    expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain(CANONICAL_SKILL);

    // No Cursor-specific rule file — Cursor reads AGENTS.md.
    expect(existsSync(join(dir, '.cursor'))).toBe(false);
  });

  test('only wires the agents that were selected', () => {
    const result = wireCodingAgents({ repoRoot: dir, agents: ['opencode', 'claude'], overwrite: false });

    expect(result.written.sort()).toEqual(
      [
        '.agents/skills → ../skills',
        '.claude/agents → ../agents',
        '.claude/commands → ../harnesses/opencode/commands',
        '.claude/skills → ../skills',
        '.opencode → harnesses/opencode',
      ].sort(),
    );
    // No codex/cursor selected → no AGENTS.md.
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
    expect(second.skipped.sort()).toEqual(['.agents/skills', '.opencode', 'AGENTS.md'].sort());

    // With overwrite the stale link/file is removed and re-created cleanly.
    const third = wireCodingAgents({ repoRoot: dir, agents, overwrite: true });
    expect(third.skipped).toEqual([]);
    expect(lstatSync(join(dir, '.opencode')).isSymbolicLink()).toBe(true);
  });
});
