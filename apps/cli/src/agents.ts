import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type CodingAgent = 'opencode' | 'claude' | 'codex' | 'cursor';

export const SUPPORTED_AGENTS: readonly CodingAgent[] = ['opencode', 'claude', 'codex', 'cursor'] as const;

export const DEFAULT_PRIMARY: CodingAgent = 'codex';

/** Path of the canonical Kortix skill, relative to repo root. */
const CANONICAL_SKILL = '.kortix/opencode/skills/kortix-system/SKILL.md';

interface InstallResult {
  agent: CodingAgent;
  written: string[];
  skipped: string[];
}

interface InstallAgentsInput {
  repoRoot: string;
  agents: readonly CodingAgent[];
  overwrite: boolean;
}

interface InstallAgentsResult {
  written: string[];
  skipped: string[];
}

/**
 * Wire each chosen coding agent up to the canonical Kortix skill at
 * `.kortix/opencode/skills/kortix-system/SKILL.md`. On-demand-skill
 * agents (opencode, claude) get a tiny wrapper at their native discovery
 * path. Always-loaded agents (codex AGENTS.md, cursor rules) get a tiny
 * stub that points them at the canonical skill.
 */
export function installAgentSkills(input: InstallAgentsInput): InstallAgentsResult {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const agent of input.agents) {
    const res = installOne(input.repoRoot, agent, input.overwrite);
    written.push(...res.written);
    skipped.push(...res.skipped);
  }

  return { written, skipped };
}

function installOne(repoRoot: string, agent: CodingAgent, overwrite: boolean): InstallResult {
  const written: string[] = [];
  const skipped: string[] = [];

  if (agent === 'opencode' || agent === 'claude') {
    const wrapperPath =
      agent === 'opencode'
        ? '.opencode/skills/kortix/SKILL.md'
        : '.claude/skills/kortix/SKILL.md';
    const wrapperAbs = resolve(repoRoot, wrapperPath);
    if (handleExisting(wrapperAbs, overwrite)) {
      mkdirSync(dirname(wrapperAbs), { recursive: true });
      writeFileSync(wrapperAbs, skillWrapper(agent), 'utf8');
      written.push(wrapperPath);
    } else {
      skipped.push(wrapperPath);
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

/** Return true if it's OK to (over)write at `abs`. */
function handleExisting(abs: string, overwrite: boolean): boolean {
  let st;
  try {
    st = lstatSync(abs, { throwIfNoEntry: false } as any) as ReturnType<typeof lstatSync> | undefined;
  } catch {
    st = undefined;
  }
  if (!st && !existsSync(abs)) return true;
  if (overwrite) {
    rmSync(abs, { force: true, recursive: false });
    return true;
  }
  return false;
}

function skillWrapper(agent: CodingAgent): string {
  return `---
name: kortix
description: Load the canonical Kortix project skill before configuring Kortix.
---

This ${agent} project skill is a discovery wrapper. Before editing \`kortix.toml\`,
\`.kortix/**\`, or any Kortix agent/runtime configuration, read
\`${CANONICAL_SKILL}\`. It is the canonical reference for this repository.
`;
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
