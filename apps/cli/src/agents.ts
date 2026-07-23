import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export type CodingAgent = 'opencode' | 'claude' | 'codex' | 'pi';

export const SUPPORTED_AGENTS: readonly CodingAgent[] = [
  'opencode',
  'claude',
  'codex',
  'pi',
] as const;

// Was 'codex' pre-`876742672`, when a fresh project's kortix.yaml declared
// all four runtimes and any local default was non-contradictory. Since
// `876742672` (OpenCode-first by default; Claude/Codex/Pi gated behind the
// project's `experimental_harnesses` flag), a headless/`-y` `kortix init`
// with `codex` here wired local editor compatibility for a coding agent the
// project's own cloud runtime doesn't even declare by default — a
// discoverable-only-after-the-fact mismatch with no CLI output calling it
// out (docs/specs/2026-07-21-cli-credential-model-ux.md §1.7/§G5). Changed
// to match the cloud default rather than layer on a disclosure message: the
// two are conceptually allowed to diverge, but nothing here previously
// argued for `codex` specifically over any other agent, so removing the
// contradiction outright is preferable to explaining it every run.
export const DEFAULT_PRIMARY: CodingAgent = 'opencode';

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
 * Native discovery paths for the local coding agents. `.opencode/skills` is
 * the canonical tree. Claude Code, Codex, and Pi receive direct skill links.
 * Codex also receives the cross-tool `.agents` compatibility link:
 *
 *   .claude/skills → ../.opencode/skills
 *   .codex/skills  → ../.opencode/skills
 *   .pi/skills     → ../.opencode/skills
 *   .agents        → .opencode
 */
const AGENT_LINKS: Partial<Record<CodingAgent, ReadonlyArray<{ path: string; target: string }>>> = {
  claude: [{ path: '.claude/skills', target: '../.opencode/skills' }],
  codex: [
    { path: '.codex/skills', target: '../.opencode/skills' },
    { path: '.agents', target: '.opencode' },
  ],
  pi: [{ path: '.pi/skills', target: '../.opencode/skills' }],
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
 * Wire each chosen local coding agent to the canonical skill tree. Codex and
 * Pi also receive a root `AGENTS.md` pointer, which both tools read natively.
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

  const legacySkip = reconcileLegacyOpencodeSymlink(input.repoRoot, {
    keepIfTargetExists: true,
  });
  if (legacySkip) skipped.push(legacySkip);

  for (const agent of input.agents) {
    for (const link of AGENT_LINKS[agent] ?? []) {
      const abs = resolve(input.repoRoot, link.path);
      try {
        if (lstatSync(abs).isSymbolicLink() && readlinkSync(abs) === link.target) continue;
      } catch {
        // Missing paths continue into creation.
      }
      if (!handleExisting(abs, input.overwrite)) {
        skipped.push(link.path);
      } else {
        try {
          mkdirSync(dirname(abs), { recursive: true });
          symlinkSync(link.target, abs);
          written.push(`${link.path} → ${link.target}`);
        } catch (err) {
          // Symlinks need elevated privileges on some platforms (e.g. Windows
          // without Developer Mode). Never fail init over it — just note it.
          skipped.push(`${link.path} (symlink unsupported: ${(err as Error).message})`);
        }
      }
    }
    if (agent === 'codex' || agent === 'pi') wantAgentsMd = true;
  }

  // AGENTS.md — project instructions loaded natively by Codex and Pi.
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
    st = lstatSync(abs, { throwIfNoEntry: false } as any) as
      ReturnType<typeof lstatSync> | undefined;
  } catch {
    st = undefined;
  }
  if (!st && !existsSync(abs)) return true;
  if (overwrite) {
    if (st?.isDirectory() && !st.isSymbolicLink()) return false;
    rmSync(abs, { force: true, recursive: false });
    return true;
  }
  return false;
}

function agentsPointer(): string {
  return `# Kortix project

This repository is a [Kortix](https://kortix.ai) project. Its agent runtime
manifest is \`kortix.yaml\`. Kortix cloud sessions use the manifest's v3 runtime
profiles and launch ACP harness adapters. The canonical skill tree is
\`.opencode/skills\`. Native Claude Code, Codex, and Pi skill directories link
to that tree. Codex also receives the \`.agents\` compatibility path.

Whenever the user asks about Kortix — \`kortix.yaml\`, triggers, secrets, the
sandbox image, sessions, connectors, deployed services, runtime profiles, or how
to configure an ACP harness — read \`${CANONICAL_SKILL}\` first. It is the
canonical reference.

For any other task, proceed normally.
`;
}
