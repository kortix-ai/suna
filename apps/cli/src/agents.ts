import { existsSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CodingAgent = 'opencode' | 'claude' | 'codex' | 'pi' | 'cursor';

export const SUPPORTED_AGENTS: readonly CodingAgent[] = [
  'opencode',
  'claude',
  'codex',
  'pi',
  'cursor',
] as const;

export const DEFAULT_PRIMARY: CodingAgent = 'codex';

/**
 * Path of the canonical Kortix skill, relative to repo root.
 *
 * `kortix-cli`, not `kortix-system`: the rest of the `kortix-*` family is
 * injected into sandboxes at boot rather than committed, so it is absent from a
 * local checkout — and this path is handed to LOCAL coding agents via the
 * generated AGENTS.md, where a dangling reference just wastes a file read.
 * `kortix-cli` ships in the scaffold and is the front door to the others.
 */
export const CANONICAL_SKILL = '.kortix/opencode/skills/kortix-cli/SKILL.md';

/** The starter's canonical project skill source. */
const OPENCODE_DIR = '.kortix/opencode';

/**
 * Native discovery directory each agent reads. We symlink it straight at the
 * OpenCode config dir so the agent picks up its shared skills + agents:
 *
 *   .opencode → .kortix/opencode   (OpenCode native; recursive skill discovery)
 *   .claude   → .kortix/opencode   (Claude Code: .claude/skills, .claude/agents — flat, depth-1)
 *   .agents   → .kortix/opencode   (Codex + the cross-tool AGENTS standard: .agents/skills, recursive)
 *   .pi       → .kortix/opencode   (Pi: .pi/skills)
 *
 * Codex's documented project skills dir is `.agents/skills` (not `.codex/`), and
 * `.agents/skills` is what OpenCode + other agent tools read too — so the codex
 * choice wires `.agents`. Each link targets `.kortix/opencode` directly (not via
 * `.opencode`) so any agent can be wired independently. Pi also reads a root
 * `AGENTS.md`. Cursor has no directory of its own and reads `AGENTS.md`.
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
  pi: '.pi',
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
 * Wire each selected local coding tool to the starter's canonical skill source.
 * OpenCode, Claude Code, Codex, and Pi get a native discovery-directory link.
 * Codex, Pi, and Cursor also get a root `AGENTS.md` pointer.
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
    if (agent === 'codex' || agent === 'pi' || agent === 'cursor') wantAgentsMd = true;
  }

  // AGENTS.md is loaded by Codex, Pi, and Cursor. Write it once.
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
config lives under \`.kortix/\` and the manifest is \`kortix.yaml\`. The starter's
canonical system skills are available through each wired tool's native discovery
location.

Whenever the user asks about Kortix — \`kortix.yaml\`, triggers, secrets, the
sandbox image, sessions, connectors, ACP, runtime profiles, or OpenCode,
Claude Code, Codex, and Pi configuration — read \`${CANONICAL_SKILL}\` first.
It is the canonical reference.

For any other task, proceed normally.
`;
}
