import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export type CodingAgent = 'opencode' | 'claude' | 'codex' | 'cursor';

export const SUPPORTED_AGENTS: readonly CodingAgent[] = ['opencode', 'claude', 'codex', 'cursor'] as const;

export const DEFAULT_PRIMARY: CodingAgent = 'codex';

/** Path of the canonical Kortix skill, relative to repo root. */
export const CANONICAL_SKILL = '.kortix/opencode/skills/kortix-system/SKILL.md';

interface InstallResult {
  agent: CodingAgent;
  written: string[];
  skipped: string[];
}

export interface InstallAgentsInput {
  repoRoot: string;
  agents: readonly CodingAgent[];
  overwrite: boolean;
}

export interface InstallAgentsResult {
  written: string[];
  skipped: string[];
}

/**
 * Wire each chosen coding agent up to the canonical Kortix skill at
 * `.kortix/opencode/skills/kortix-system/SKILL.md`. On-demand-skill
 * agents (opencode, claude) get a symlink at their native discovery
 * path. Always-loaded agents (codex AGENTS.md, cursor rules) get a
 * tiny stub that points them at the canonical skill.
 *
 * Also always drops `.agents/skills/kortix/SKILL.md` as the universal
 * Agent Skills convention — opencode reads it natively, Prime's CLI
 * uses it as the shared path for codex/amp/letta, and any future
 * agent following the open standard will pick it up.
 */
export function installAgentSkills(input: InstallAgentsInput): InstallAgentsResult {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const agent of input.agents) {
    const res = installOne(input.repoRoot, agent, input.overwrite);
    written.push(...res.written);
    skipped.push(...res.skipped);
  }

  const universal = installUniversalAgentsLink(input.repoRoot, input.overwrite);
  written.push(...universal.written);
  skipped.push(...universal.skipped);

  return { written, skipped };
}

/** Universal `.agents/skills/kortix/SKILL.md` symlink — the cross-agent
 * Agent Skills convention. */
function installUniversalAgentsLink(
  repoRoot: string,
  overwrite: boolean,
): { written: string[]; skipped: string[] } {
  const canonicalAbs = resolve(repoRoot, CANONICAL_SKILL);
  const linkPath = '.agents/skills/kortix/SKILL.md';
  const linkAbs = resolve(repoRoot, linkPath);
  if (!handleExisting(linkAbs, overwrite)) {
    return { written: [], skipped: [linkPath] };
  }
  mkdirSync(dirname(linkAbs), { recursive: true });
  const linkTarget = relative(dirname(linkAbs), canonicalAbs);
  symlinkSync(linkTarget, linkAbs);
  return { written: [`${linkPath} -> ${CANONICAL_SKILL}`], skipped: [] };
}

function installOne(repoRoot: string, agent: CodingAgent, overwrite: boolean): InstallResult {
  const written: string[] = [];
  const skipped: string[] = [];

  const canonicalAbs = resolve(repoRoot, CANONICAL_SKILL);

  if (agent === 'opencode' || agent === 'claude') {
    const linkPath =
      agent === 'opencode'
        ? '.opencode/skills/kortix/SKILL.md'
        : '.claude/skills/kortix/SKILL.md';
    const linkAbs = resolve(repoRoot, linkPath);
    if (handleExisting(linkAbs, overwrite)) {
      mkdirSync(dirname(linkAbs), { recursive: true });
      const linkTarget = relative(dirname(linkAbs), canonicalAbs);
      symlinkSync(linkTarget, linkAbs);
      written.push(`${linkPath} -> ${CANONICAL_SKILL}`);
    } else {
      skipped.push(linkPath);
    }
  } else if (agent === 'codex') {
    const stubPath = 'AGENTS.md';
    const stubAbs = resolve(repoRoot, stubPath);
    if (handleExisting(stubAbs, overwrite)) {
      writeFileSync(stubAbs, codexStub(), 'utf8');
      written.push(stubPath);
    } else {
      skipped.push(stubPath);
    }
  } else if (agent === 'cursor') {
    const stubPath = '.cursor/rules/kortix.mdc';
    const stubAbs = resolve(repoRoot, stubPath);
    if (handleExisting(stubAbs, overwrite)) {
      mkdirSync(dirname(stubAbs), { recursive: true });
      writeFileSync(stubAbs, cursorStub(), 'utf8');
      written.push(stubPath);
    } else {
      skipped.push(stubPath);
    }
  }

  return { agent, written, skipped };
}

/** Return true if it's OK to (over)write at `abs`. Idempotent symlinks
 * pointing at the right target are treated as "already correct" and
 * left alone (still counted as skipped so the user sees nothing got
 * clobbered). */
function handleExisting(abs: string, overwrite: boolean): boolean {
  let st;
  try {
    st = statSync(abs, { throwIfNoEntry: false } as any) as ReturnType<typeof statSync> | undefined;
  } catch {
    st = undefined;
  }
  if (!st && !existsSync(abs)) return true;
  if (overwrite) {
    try {
      require('node:fs').rmSync(abs, { force: true, recursive: false });
    } catch {
      /* fall through; symlinkSync will throw if still present */
    }
    return true;
  }
  return false;
}

function codexStub(): string {
  return `# Kortix project

This repository is a [Kortix](https://kortix.ai) project — its agent runtime
config lives under \`.kortix/\` and the manifest is \`kortix.toml\`.

Whenever the user asks about Kortix — \`kortix.toml\`, triggers, secrets, the
sandbox image, sessions, deployable apps, or how to configure OpenCode
(agents / skills / commands / tools / plugins / MCP servers / custom tools /
ACP) — read \`${CANONICAL_SKILL}\` first. It is the canonical reference.

For any other task, proceed normally.
`;
}

function cursorStub(): string {
  return `---
description: Kortix project — load the kortix skill before editing kortix.toml or .kortix/**
globs: ["kortix.toml", ".kortix/**", ".opencode/**"]
alwaysApply: false
---

This repository is a [Kortix](https://kortix.ai) project. The canonical
reference for everything Kortix-related — the \`kortix.toml\` manifest,
triggers, secrets, sandbox image, session lifecycle, deployable apps, and
how to configure OpenCode (agents, skills, commands, tools, plugins, MCP
servers, custom tools, ACP) — lives at \`${CANONICAL_SKILL}\`.

Before editing anything under \`kortix.toml\`, \`.kortix/\`, or \`.opencode/\`,
read that file.
`;
}
