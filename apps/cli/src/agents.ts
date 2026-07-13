import { existsSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CodingAgent = 'opencode' | 'claude' | 'codex' | 'cursor';

export const SUPPORTED_AGENTS: readonly CodingAgent[] = ['opencode', 'claude', 'codex', 'cursor'] as const;

export const DEFAULT_PRIMARY: CodingAgent = 'codex';

/** Path of the canonical Kortix skill, relative to repo root. */
export const CANONICAL_SKILL = '.kortix/opencode/skills/kortix-system/SKILL.md';

/** Legacy OpenCode harness config dir used for local compatibility links. */
const OPENCODE_DIR = '.kortix/opencode';

/**
 * Native discovery directory each local coding agent reads. These compatibility
 * links let local tools reuse the starter's OpenCode-harness skills/agents:
 *
 *   .opencode → .kortix/opencode   (OpenCode native; recursive skill discovery)
 *   .claude   → .kortix/opencode   (Claude Code: .claude/skills, .claude/agents — flat, depth-1)
 *   .agents   → .kortix/opencode   (Codex + the cross-tool AGENTS standard: .agents/skills, recursive)
 *
 * Codex's documented project skills dir is `.agents/skills` (not `.codex/`), so
 * the codex choice wires `.agents`. Each link targets `.kortix/opencode`
 * directly (not via `.opencode`) so any agent can be wired independently.
 * Cursor has no dir of its own — it reads the root `AGENTS.md` natively.
 *
 * Note: Claude Code scans `.claude/skills` only one level deep, so skills nested
 * under a grouping folder (e.g. `<skill>/SKILL.md`) are
 * NOT discovered locally by Claude. They still load in the OpenCode sandbox and
 * for Codex, both of which discover skills recursively.
 */
const AGENT_LINK: Partial<Record<CodingAgent, string>> = {
  opencode: '.opencode',
  claude: '.claude',
  codex: '.agents',
};

export interface WireAgentsInput {
  repoRoot: string;
  agents: readonly CodingAgent[];
  overwrite: boolean;
}

export interface WireAgentsResult {
  written: string[];
  skipped: string[];
}

/**
 * Wire each chosen local coding agent to the starter compatibility config.
 * opencode / claude / codex get a symlink from their native discovery dir to
 * `.kortix/opencode` (sharing the starter's skills + agents). codex and cursor
 * also get a root `AGENTS.md` pointer — the universal, always-loaded
 * instructions file they read natively (which is why Cursor needs no rule file
 * of its own).
 */
export function wireCodingAgents(input: WireAgentsInput): WireAgentsResult {
  const written: string[] = [];
  const skipped: string[] = [];
  let wantAgentsMd = false;

  for (const agent of input.agents) {
    const link = AGENT_LINK[agent];
    if (link) {
      const abs = resolve(input.repoRoot, link);
      if (!handleExisting(abs, input.overwrite)) {
        skipped.push(link);
      } else {
        try {
          symlinkSync(OPENCODE_DIR, abs);
          written.push(`${link} → ${OPENCODE_DIR}`);
        } catch (err) {
          // Symlinks need elevated privileges on some platforms (e.g. Windows
          // without Developer Mode). Never fail init over it — just note it.
          skipped.push(`${link} (symlink unsupported: ${(err as Error).message})`);
        }
      }
    }
    if (agent === 'codex' || agent === 'cursor') wantAgentsMd = true;
  }

  // AGENTS.md — the universal, always-loaded instructions file Codex injects on
  // the first turn and Cursor applies as a rule. Written once if either is wired.
  if (wantAgentsMd) {
    const abs = resolve(input.repoRoot, 'AGENTS.md');
    if (handleExisting(abs, input.overwrite)) {
      writeFileSync(abs, agentsPointer(), 'utf8');
      written.push('AGENTS.md');
    } else {
      skipped.push('AGENTS.md');
    }
  }

  return { written, skipped };
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
    // force + non-recursive: removes a stale symlink or file without ever
    // recursively wiping a real directory the user may have created.
    rmSync(abs, { force: true, recursive: false });
    return true;
  }
  return false;
}

function agentsPointer(): string {
  return `# Kortix project

This repository is a [Kortix](https://kortix.ai) project — its agent runtime
manifest is \`kortix.yaml\`. Kortix cloud sessions use the manifest's v3 runtime
profiles and launch ACP harness adapters. This starter also symlinks the legacy
OpenCode harness config into wired local coding-agent discovery dirs
(\`.opencode\`, \`.claude\`, \`.agents\`) for local editing compatibility.

Whenever the user asks about Kortix — \`kortix.yaml\`, triggers, secrets, the
sandbox image, sessions, connectors, deployable apps, runtime profiles, or how
to configure an ACP harness — read \`${CANONICAL_SKILL}\` first. It is the
canonical reference.

For any other task, proceed normally.
`;
}
