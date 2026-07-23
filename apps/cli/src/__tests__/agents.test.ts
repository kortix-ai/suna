import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CANONICAL_SKILL,
  SUPPORTED_AGENTS,
  reconcileLegacyOpencodeSymlink,
  wireCodingAgents,
} from '../agents';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-agents-'));
  mkdirSync(join(dir, '.opencode/skills/kortix-system'), { recursive: true });
  writeFileSync(join(dir, CANONICAL_SKILL), 'canonical skill', 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('wireCodingAgents', () => {
  test('matches the four runnable ACP harnesses', () => {
    expect(SUPPORTED_AGENTS).toEqual(['opencode', 'claude', 'codex', 'pi']);
  });

  test('all agents share the canonical skill tree and receive one AGENTS.md', () => {
    const result = wireCodingAgents({
      repoRoot: dir,
      agents: ['opencode', 'claude', 'codex', 'pi'],
      overwrite: false,
    });

    expect(result.skipped).toEqual([]);
    expect(result.written.sort()).toEqual(
      [
        '.agents → .opencode',
        '.claude/skills → ../.opencode/skills',
        '.codex/skills → ../.opencode/skills',
        '.pi/skills → ../.opencode/skills',
        'AGENTS.md',
      ].sort(),
    );

    for (const link of ['.claude/skills', '.codex/skills', '.pi/skills']) {
      expect(lstatSync(join(dir, link)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dir, link))).toBe('../.opencode/skills');
      const skill = join(dir, link, 'kortix-system/SKILL.md');
      expect(readFileSync(skill, 'utf8')).toBe('canonical skill');
    }
    expect(readlinkSync(join(dir, '.agents'))).toBe('.opencode');

    // `.opencode` itself stays the real directory — no self-link.
    expect(lstatSync(join(dir, '.opencode')).isSymbolicLink()).toBe(false);

    // AGENTS.md is a real file pointing at the canonical skill, written once.
    expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain(CANONICAL_SKILL);

    expect(existsSync(join(dir, '.pi/skills'))).toBe(true);
  });

  test('only wires the agents that were selected', () => {
    const result = wireCodingAgents({
      repoRoot: dir,
      agents: ['opencode', 'claude'],
      overwrite: false,
    });

    // opencode is the real dir already — it contributes no link of its own.
    expect(result.written).toEqual(['.claude/skills → ../.opencode/skills']);
    expect(existsSync(join(dir, '.agents'))).toBe(false);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
  });

  test('pi wires its native skills and AGENTS.md project instructions', () => {
    const result = wireCodingAgents({
      repoRoot: dir,
      agents: ['pi'],
      overwrite: false,
    });

    expect(result.written).toEqual(['.pi/skills → ../.opencode/skills', 'AGENTS.md']);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain(CANONICAL_SKILL);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
    expect(existsSync(join(dir, '.agents'))).toBe(false);
  });

  test('preserves existing links/file without --overwrite, replaces them with it', () => {
    const agents = ['opencode', 'codex'] as const;
    expect(wireCodingAgents({ repoRoot: dir, agents, overwrite: false }).skipped).toEqual([]);

    // Re-running without overwrite leaves everything in place (all skipped).
    const second = wireCodingAgents({
      repoRoot: dir,
      agents,
      overwrite: false,
    });
    expect(second.written).toEqual([]);
    expect(second.skipped.sort()).toEqual(['AGENTS.md'].sort());

    // With overwrite the stale link/file is removed and re-created cleanly.
    // The real `.opencode` directory (from beforeEach) is left untouched throughout.
    const third = wireCodingAgents({ repoRoot: dir, agents, overwrite: true });
    expect(third.skipped).toEqual([]);
    expect(lstatSync(join(dir, '.agents')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, '.opencode')).isSymbolicLink()).toBe(false);
  });

  test('overwrite preserves a real native harness directory', () => {
    mkdirSync(join(dir, '.claude/skills/custom'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/custom/SKILL.md'), 'custom', 'utf8');

    const result = wireCodingAgents({
      repoRoot: dir,
      agents: ['claude'],
      overwrite: true,
    });

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['.claude/skills']);
    expect(readFileSync(join(dir, '.claude/skills/custom/SKILL.md'), 'utf8')).toBe('custom');
  });

  test('wireCodingAgents links native skill dirs and skips opencode self-link', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
    mkdirSync(join(root, '.opencode'), { recursive: true });
    const result = wireCodingAgents({
      repoRoot: root,
      agents: ['opencode', 'claude', 'codex'],
      overwrite: false,
    });
    expect(existsSync(join(root, '.claude'))).toBe(true);
    expect(readlinkSync(join(root, '.claude/skills'))).toBe('../.opencode/skills');
    expect(readlinkSync(join(root, '.codex/skills'))).toBe('../.opencode/skills');
    expect(readlinkSync(join(root, '.agents'))).toBe('.opencode');
    expect(lstatSync(join(root, '.opencode')).isSymbolicLink()).toBe(false);
    expect(result.written).not.toContainEqual(expect.stringContaining('.opencode →'));
    rmSync(root, { recursive: true, force: true });
  });

  test('wireCodingAgents removes a DANGLING legacy .opencode symlink (target already gone)', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
    // Legacy scaffold left `.opencode` → `.kortix/opencode`, but the repo has
    // since migrated (or the tree was deleted) — `.kortix/opencode` no longer
    // exists as a real directory. No `opencode` in the agent list either, to
    // prove the removal no longer needs to be gated on choosing opencode.
    symlinkSync('.kortix/opencode', join(root, '.opencode'));
    const result = wireCodingAgents({
      repoRoot: root,
      agents: ['claude'],
      overwrite: false,
    });
    expect(existsSync(join(root, '.opencode'))).toBe(false);
    expect(lstatSync(join(root, '.claude/skills')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, '.claude/skills'))).toBe('../.opencode/skills');
    expect(result.skipped).not.toContainEqual(expect.stringContaining('.opencode'));
    rmSync(root, { recursive: true, force: true });
  });

  test('keeps a legacy .opencode symlink when the un-migrated .kortix/opencode target still exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
    // Un-migrated legacy repo: the real scaffold content still lives at
    // `.kortix/opencode`, and `.opencode` is a compat symlink onto it. It's
    // load-bearing — OpenCode's native discovery reads `.opencode`, and
    // `.claude`/`.agents` link onto `.opencode` too — so removing it here
    // would dangle the whole chain. No `opencode` in the agent list, since
    // the rule must not be gated on that anymore.
    mkdirSync(join(root, '.kortix/opencode'), { recursive: true });
    symlinkSync('.kortix/opencode', join(root, '.opencode'));
    const result = wireCodingAgents({
      repoRoot: root,
      agents: ['claude'],
      overwrite: false,
    });
    expect(lstatSync(join(root, '.opencode')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, '.opencode'))).toBe('.kortix/opencode');
    expect(result.skipped).not.toContainEqual(expect.stringContaining('.opencode'));
    rmSync(root, { recursive: true, force: true });
  });

  test('never touches a custom .opencode symlink pointing anywhere else, target present or missing', () => {
    const present = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
    mkdirSync(join(present, 'elsewhere'), { recursive: true });
    symlinkSync('elsewhere', join(present, '.opencode'));
    wireCodingAgents({
      repoRoot: present,
      agents: ['opencode', 'claude'],
      overwrite: false,
    });
    expect(lstatSync(join(present, '.opencode')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(present, '.opencode'))).toBe('elsewhere');
    rmSync(present, { recursive: true, force: true });

    const missing = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
    // Custom symlink whose target doesn't even exist — still not our legacy
    // target, so still never touched (no dangling-cleanup rule applies).
    symlinkSync('nowhere/at-all', join(missing, '.opencode'));
    wireCodingAgents({
      repoRoot: missing,
      agents: ['opencode', 'claude'],
      overwrite: false,
    });
    expect(lstatSync(join(missing, '.opencode')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(missing, '.opencode'))).toBe('nowhere/at-all');
    rmSync(missing, { recursive: true, force: true });
  });

  test('a real .opencode directory is always left alone (never a symlink target)', () => {
    // Covered implicitly by every other test's `beforeEach` (a real
    // `.opencode/skills/kortix-system` dir), asserted explicitly here too.
    const result = wireCodingAgents({
      repoRoot: dir,
      agents: ['claude'],
      overwrite: false,
    });
    expect(lstatSync(join(dir, '.opencode')).isSymbolicLink()).toBe(false);
    expect(result.skipped).not.toContainEqual(expect.stringContaining('.opencode'));
  });

  test('wireCodingAgents creates the .opencode compat symlink on a fresh legacy clone (.kortix/opencode real, no .opencode entry at all)', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
    // A fresh clone of an un-migrated pre-1.x repo: the real scaffold content
    // is committed at `.kortix/opencode`, but the old `.opencode` symlink was
    // local-only (`.git/info/exclude`), never committed — so a fresh clone
    // has NO `.opencode` entry whatsoever, not even a dangling one.
    mkdirSync(join(root, '.kortix/opencode/skills/kortix-system'), {
      recursive: true,
    });
    writeFileSync(
      join(root, '.kortix/opencode/skills/kortix-system/SKILL.md'),
      'canonical skill',
      'utf8',
    );
    expect(existsSync(join(root, '.opencode'))).toBe(false);

    const result = wireCodingAgents({
      repoRoot: root,
      agents: ['claude', 'codex'],
      overwrite: false,
    });

    expect(lstatSync(join(root, '.opencode')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, '.opencode'))).toBe('.kortix/opencode');
    // The compat chain resolves through .opencode to the real skill file.
    expect(lstatSync(join(root, '.claude/skills')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, '.claude/skills'))).toBe('../.opencode/skills');
    expect(lstatSync(join(root, '.agents')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, '.claude/skills/kortix-system/SKILL.md'), 'utf8')).toBe(
      'canonical skill',
    );
    expect(readFileSync(join(root, '.agents/skills/kortix-system/SKILL.md'), 'utf8')).toBe(
      'canonical skill',
    );
    expect(result.skipped).not.toContainEqual(expect.stringContaining('.opencode'));
    rmSync(root, { recursive: true, force: true });
  });

  test('reconcileLegacyOpencodeSymlink never creates the compat link in replace mode (applyScaffold seam), even with a real legacy target', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
    mkdirSync(join(root, '.kortix/opencode'), { recursive: true });
    expect(existsSync(join(root, '.opencode'))).toBe(false);

    const result = reconcileLegacyOpencodeSymlink(root, {
      keepIfTargetExists: false,
    });

    expect(result).toBeUndefined();
    expect(existsSync(join(root, '.opencode'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test('reconcileLegacyOpencodeSymlink creates nothing when neither .opencode nor a real .kortix/opencode exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-cli-'));

    const result = reconcileLegacyOpencodeSymlink(root, {
      keepIfTargetExists: true,
    });

    expect(result).toBeUndefined();
    expect(existsSync(join(root, '.opencode'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test('a legacy dangling symlink that fails to remove is reported as skipped, not thrown', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
    symlinkSync('.kortix/opencode', join(root, '.opencode'));
    // Deny write on the parent dir so unlinking the `.opencode` entry EACCESs.
    chmodSync(root, 0o555);
    try {
      const result = wireCodingAgents({
        repoRoot: root,
        agents: ['claude'],
        overwrite: false,
      });
      expect(result.skipped.some((s) => s.startsWith('.opencode'))).toBe(true);
    } finally {
      chmodSync(root, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
