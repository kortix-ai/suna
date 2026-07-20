import { existsSync, lstatSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CodingAgent = 'opencode' | 'claude' | 'codex' | 'cursor';

export const SUPPORTED_AGENTS: readonly CodingAgent[] = ['opencode', 'claude', 'codex', 'cursor'] as const;

export const DEFAULT_PRIMARY: CodingAgent = 'codex';

/** Path of the canonical Kortix skill, relative to repo root. */
export const CANONICAL_SKILL = '.opencode/skills/kortix-system/SKILL.md';

/** Canonical OpenCode harness config dir. This is now a real directory at
 *  repo root (scaffolded directly by the starter) rather than a compatibility
 *  link target — it needs no link of its own. */
const OPENCODE_DIR = '.opencode';

/** Exact relative target a pre-1.x scaffold symlinked `.opencode` onto. Only a
 *  symlink whose target matches this *exact* string is ever considered
 *  "legacy" — a user's own symlink to anywhere else is never touched. */
const LEGACY_OPENCODE_TARGET = '.kortix/opencode';

/**
 * Native discovery directory each local coding agent reads. `.opencode` is
 * the real, canonical OpenCode harness config dir at repo root, so it needs
 * no link of its own. Claude Code and Codex get a compatibility link onto it
 * so local tools can reuse the same skills/agents:
 *
 *   .claude   → .opencode   (Claude Code: .claude/skills, .claude/agents — flat, depth-1)
 *   .agents   → .opencode   (Codex + the cross-tool AGENTS standard: .agents/skills, recursive)
 *
 * Codex's documented project skills dir is `.agents/skills` (not `.codex/`), so
 * the codex choice wires `.agents`. Cursor has no dir of its own — it reads
 * the root `AGENTS.md` natively.
 *
 * Note: Claude Code scans `.claude/skills` only one level deep, so skills nested
 * under a grouping folder (e.g. `<skill>/SKILL.md`) are
 * NOT discovered locally by Claude. They still load in the OpenCode sandbox and
 * for Codex, both of which discover skills recursively.
 */
const AGENT_LINK: Partial<Record<CodingAgent, string>> = {
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
 * claude / codex get a symlink from their native discovery dir onto the real
 * `.opencode` (sharing its skills + agents). `.opencode` itself needs no
 * link — it's the real directory. codex and cursor also get a root
 * `AGENTS.md` pointer — the universal, always-loaded instructions file they
 * read natively (which is why Cursor needs no rule file of its own).
 *
 * Every call also reconciles a legacy `.opencode` symlink left by a pre-1.x
 * scaffold (which pointed `.opencode` at `.kortix/opencode`) — see
 * `reconcileLegacyOpencodeSymlink` for the exact, state-aware rule. This runs
 * unconditionally (not gated on choosing `opencode`), so e.g.
 * `--force --agents claude` still resolves a dangling legacy link instead of
 * leaving the whole `.claude`/`.agents` → `.opencode` compat chain dangling.
 */
export function wireCodingAgents(input: WireAgentsInput): WireAgentsResult {
  const written: string[] = [];
  const skipped: string[] = [];
  let wantAgentsMd = false;

  const legacySkip = reconcileLegacyOpencodeSymlink(input.repoRoot, { keepIfTargetExists: true });
  if (legacySkip) skipped.push(legacySkip);

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

/**
 * True only when `abs` is a symlink whose target is *exactly*
 * `LEGACY_OPENCODE_TARGET`. Anything else — no entry, a real file/directory,
 * or a symlink to some other target (a user's own custom link) — is `false`
 * and must never be touched by the logic below.
 */
function isLegacyOpencodeSymlink(abs: string): boolean {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return false;
  }
  if (!st.isSymbolicLink()) return false;
  try {
    return readlinkSync(abs) === LEGACY_OPENCODE_TARGET;
  } catch {
    return false;
  }
}

/**
 * State-aware reconciliation of a legacy `.opencode` symlink left by a
 * pre-1.x scaffold (which pointed `.opencode` at `.kortix/opencode`). Only a
 * symlink whose target is the *exact* legacy path is ever considered —
 * a user's own custom symlink to anywhere else is never touched, regardless
 * of anything else about repo state.
 *
 *  - `keepIfTargetExists: true` (the `wireCodingAgents` steady-state call):
 *    if `.kortix/opencode` is still a real directory (an un-migrated legacy
 *    repo), the symlink is KEPT — it's load-bearing compat. OpenCode's
 *    native discovery reads `.opencode`, and `.claude`/`.agents` now link
 *    onto `.opencode` too, so removing it would dangle the whole chain.
 *  - Otherwise (target already gone — a dangling legacy link, e.g. after
 *    migration or manual cleanup; or `keepIfTargetExists: false`, the
 *    fresh-scaffold seam that's about to supersede it with a real directory
 *    outright) the symlink is removed, wrapped in try/catch — a permissions
 *    failure never fails init, it's just reported back as skipped.
 *
 * Returns a skip note on removal failure, `undefined` otherwise (including
 * when nothing was touched at all).
 */
export function reconcileLegacyOpencodeSymlink(
  repoRoot: string,
  opts: { keepIfTargetExists: boolean },
): string | undefined {
  const abs = resolve(repoRoot, OPENCODE_DIR);

  if (isLegacyOpencodeSymlink(abs)) {
    if (opts.keepIfTargetExists) {
      const targetAbs = resolve(repoRoot, LEGACY_OPENCODE_TARGET);
      const targetIsRealDir = existsSync(targetAbs) && statSync(targetAbs).isDirectory();
      if (targetIsRealDir) return undefined;
    }

    try {
      rmSync(abs, { force: true });
      return undefined;
    } catch (err) {
      // Mirrors the symlink-creation error handling above: never fail init
      // over a cleanup we can't perform — just note it.
      return `${OPENCODE_DIR} (legacy symlink cleanup failed: ${(err as Error).message})`;
    }
  }

  // Nothing at all at `.opencode` — the fresh-legacy-clone case. A pre-1.x
  // scaffold's `.opencode` symlink was local-only (written to
  // `.git/info/exclude`, never committed), so a fresh clone of an
  // un-migrated project has no `.opencode` entry whatsoever, only the real
  // `.kortix/opencode` content dir. Only in keep mode — never
  // `applyScaffold`'s replace mode (`keepIfTargetExists: false`), which is
  // about to supersede any of this with a real directory of its own — and
  // only when that legacy content dir genuinely exists, create the compat
  // symlink so `.claude`/`.agents` (which point at the literal `.opencode`)
  // don't dangle. A real file/dir or a user's own custom symlink already
  // sitting at `.opencode` is left alone (handled by the branch above via
  // `isLegacyOpencodeSymlink`, or simply not empty here).
  if (opts.keepIfTargetExists) {
    let hasEntry = true;
    try {
      lstatSync(abs);
    } catch {
      hasEntry = false;
    }
    if (!hasEntry) {
      const targetAbs = resolve(repoRoot, LEGACY_OPENCODE_TARGET);
      const targetIsRealDir = existsSync(targetAbs) && statSync(targetAbs).isDirectory();
      if (targetIsRealDir) {
        try {
          symlinkSync(LEGACY_OPENCODE_TARGET, abs);
        } catch (err) {
          return `${OPENCODE_DIR} (legacy symlink creation failed: ${(err as Error).message})`;
        }
      }
    }
  }

  return undefined;
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
sandbox image, sessions, connectors, deployed services, runtime profiles, or how
to configure an ACP harness — read \`${CANONICAL_SKILL}\` first. It is the
canonical reference.

For any other task, proceed normally.
`;
}
