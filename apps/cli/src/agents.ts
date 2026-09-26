import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AGENTS_DIR,
  LEGACY_OPENCODE_CONFIG_DIR,
  OPENCODE_CONFIG_DIR,
  SKILLS_DIR,
} from '@kortix/manifest-schema/layout';

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
export const CANONICAL_SKILL = `${SKILLS_DIR}/kortix-cli/SKILL.md`;

/**
 * Native discovery paths each agent reads (the root project layout: `agents/`,
 * `skills/`, and OpenCode's own files in `harnesses/opencode/`):
 *
 *   .opencode → harnesses/opencode   (OpenCode's config dir: plugins, tools, commands)
 *   .agents/skills → ../skills       (Codex, and OpenCode natively: the cross-tool
 *                                     `.agents/skills` location, recursive)
 *   .claude/skills → ../skills
 *   .claude/agents → ../agents
 *   .claude/commands → ../harnesses/opencode/commands
 *   .pi/skills → ../skills
 *
 * Codex's documented project skills dir is `.agents/skills` (not `.codex/`), and
 * OpenCode reads `.agents/skills` too, so both choices wire it. A local OpenCode
 * does not load the project's `agents/`: OpenCode reads agents only from its
 * config dirs, and Kortix sessions receive them compiled from `kortix.yaml`.
 * Claude Code, Codex and Pi keep their local configuration in real `.claude`,
 * `.agents` and `.pi` directories; the CLI links only the discovery
 * subdirectories into them. Pi also reads a root `AGENTS.md`. Cursor has no
 * directory of its own and reads `AGENTS.md`.
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

/** Where this checkout keeps its skills, agents and OpenCode files. */
interface LocalLayout {
  skills: string;
  agents: string;
  opencode: string;
}

/**
 * The root layout, unless the checkout is a legacy project: one with
 * `.kortix/opencode` and none of the root folders, whose links must point at
 * the legacy paths or they dangle.
 */
function localLayout(repoRoot: string): LocalLayout {
  const has = (path: string) => existsSync(resolve(repoRoot, path));
  const legacy =
    has(LEGACY_OPENCODE_CONFIG_DIR) && ![SKILLS_DIR, AGENTS_DIR, OPENCODE_CONFIG_DIR].some(has);
  return legacy
    ? {
        skills: `${LEGACY_OPENCODE_CONFIG_DIR}/skills`,
        agents: `${LEGACY_OPENCODE_CONFIG_DIR}/agents`,
        opencode: LEGACY_OPENCODE_CONFIG_DIR,
      }
    : { skills: SKILLS_DIR, agents: AGENTS_DIR, opencode: OPENCODE_CONFIG_DIR };
}

function agentLinks(layout: LocalLayout): Partial<Record<CodingAgent, readonly AgentLink[]>> {
  const sharedSkills: AgentLink = { path: '.agents/skills', target: `../${layout.skills}` };
  return {
    opencode: [{ path: '.opencode', target: layout.opencode }, sharedSkills],
    claude: [
      { path: '.claude/skills', target: `../${layout.skills}` },
      { path: '.claude/agents', target: `../${layout.agents}` },
      { path: '.claude/commands', target: `../${layout.opencode}/commands` },
    ],
    codex: [sharedSkills],
    pi: [{ path: '.pi/skills', target: `../${layout.skills}` }],
  };
}

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
  const layout = localLayout(input.repoRoot);
  const links = agentLinks(layout);
  // `.agents/skills` serves both OpenCode and Codex: wire it once.
  const seen = new Set<string>();

  for (const agent of input.agents) {
    for (const link of links[agent] ?? []) {
      if (seen.has(link.path)) continue;
      seen.add(link.path);
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
      writeFileSync(abs, agentsPointer(layout), 'utf8');
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

function agentsPointer(layout: LocalLayout): string {
  const canonicalSkill = `${layout.skills}/kortix-cli/SKILL.md`;
  return `# Kortix project

This repository is a [Kortix](https://kortix.ai) project. The manifest is
\`kortix.yaml\`; agents live in \`${layout.agents}/\`, skills in \`${layout.skills}/\`,
and OpenCode's own files in \`${layout.opencode}/\`.
The skills are available through each wired tool's native discovery location.

Whenever the user asks about Kortix — \`kortix.yaml\`, triggers, secrets, the
sandbox image, sessions, connectors, or OpenCode,
Claude Code, Codex, and Pi configuration — read \`${canonicalSkill}\` first.
It is the canonical reference.

For any other task, proceed normally.
`;
}
