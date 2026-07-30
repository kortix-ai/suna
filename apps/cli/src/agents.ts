import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
 * Native discovery paths each agent reads:
 *
 *   .opencode → .kortix/opencode   (OpenCode native; recursive skill discovery)
 *   .claude/skills → ../.kortix/opencode/skills
 *   .claude/agents → ../.kortix/opencode/agents
 *   .claude/commands → ../.kortix/opencode/commands
 *   .agents   → .kortix/opencode   (Codex + the cross-tool AGENTS standard: .agents/skills, recursive)
 *   .pi/skills → ../.kortix/opencode/skills
 *
 * Codex's documented project skills dir is `.agents/skills` (not `.codex/`), and
 * `.agents/skills` is what OpenCode + other agent tools read too — so the codex
 * choice wires `.agents`. Claude Code and Pi keep their harness-native runtime
 * files in real `.claude` and `.pi` directories. The CLI links only the native
 * discovery subdirectories into those directories. Pi also reads a root
 * `AGENTS.md`. Cursor has no directory of its own and reads `AGENTS.md`.
 *
 * Note: Claude Code scans `.claude/skills` only one level deep, so skills nested
 * under a grouping folder (e.g. `<skill>/SKILL.md`) are
 * NOT discovered locally by Claude. They still load in the OpenCode sandbox and
 * for Codex, both of which discover skills recursively.
 */
interface AgentLink {
  path: string;
  target: string;
}

const AGENT_LINKS: Partial<Record<CodingAgent, readonly AgentLink[]>> = {
  opencode: [{ path: '.opencode', target: OPENCODE_DIR }],
  claude: [
    { path: '.claude/skills', target: '../.kortix/opencode/skills' },
    { path: '.claude/agents', target: '../.kortix/opencode/agents' },
    { path: '.claude/commands', target: '../.kortix/opencode/commands' },
  ],
  codex: [{ path: '.agents', target: OPENCODE_DIR }],
  pi: [{ path: '.pi/skills', target: '../.kortix/opencode/skills' }],
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
 * OpenCode, Claude Code, Codex, and Pi get native discovery links.
 * Codex, Pi, and Cursor also get a root `AGENTS.md` pointer.
 */
export function wireCodingAgents(input: WireAgentsInput): WireAgentsResult {
  const written: string[] = [];
  const skipped: string[] = [];
  let wantAgentsMd = false;

  for (const agent of input.agents) {
    for (const link of AGENT_LINKS[agent] ?? []) {
      const abs = resolve(input.repoRoot, link.path);
      try {
        mkdirSync(dirname(abs), { recursive: true });
      } catch (err) {
        skipped.push(`${link.path} (parent unavailable: ${(err as Error).message})`);
        continue;
      }
      if (!handleExisting(abs, input.overwrite)) {
        skipped.push(link.path);
      } else {
        try {
          symlinkSync(link.target, abs);
          written.push(`${link.path} → ${link.target}`);
        } catch (err) {
          // Symlinks need elevated privileges on some platforms (e.g. Windows
          // without Developer Mode). Never fail init over it — just note it.
          skipped.push(`${link.path} (symlink unsupported: ${(err as Error).message})`);
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
  if (st?.isDirectory()) return false;
  if (overwrite) {
    // Remove a stale symlink or file. Preserve real directories.
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
