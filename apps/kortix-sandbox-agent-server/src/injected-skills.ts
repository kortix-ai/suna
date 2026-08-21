import { execFile } from 'node:child_process'
import { access, constants, cp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { logger } from './logger'

const execFileAsync = promisify(execFile)

/**
 * Image-baked copy of the always-latest Kortix system skills — `kortix-cli`
 * (the front door) plus the managed `kortix-*` family. Produced by the snapshot
 * Dockerfile so every session boots with the current bodies with zero network
 * work. Each subdirectory is a skill folder (`<name>/SKILL.md`, references, …).
 */
const BAKED_MANAGED_SKILLS_DIR = '/opt/kortix/managed-skills'

/**
 * Keep the overlay out of the user's `git status`.
 *
 * The managed family is deliberately NOT part of the scaffold commit (see
 * `getManagedSkillFiles` in `packages/starter/src/index.ts`), so every file this
 * overlay writes lands in the session working tree as an UNTRACKED file. The
 * product reads that same working tree — `GET /file/status` runs
 * `git status --porcelain -uall` — so 31 files of platform boot output were
 * presented to the user as their own uncommitted changes, on a session where the
 * agent had touched nothing. It also wedged `reload config`, which refuses with
 * `local changes` whenever `git status -- <config dir>` is non-empty.
 *
 * The rule this restores is already written down one module over, in
 * `runtime-assets.ts`: platform convergence must never dirty a working tree.
 * `.git/info/exclude` is how the CLI already hides its own platform-local files
 * (`appendGitExcludeEntries`, used by `kortix init`): repository-local, never
 * committed, and — unlike a `.gitignore` edit — it fixes projects that already
 * exist instead of only the next one created.
 *
 * Deliberately narrow:
 *   - only the skill directories this call actually injected are listed, so a
 *     user file is never hidden by a wildcard;
 *   - git ignores exclude rules for TRACKED paths, so a project that committed
 *     its own copy (every project created before the family left the scaffold)
 *     keeps showing that copy exactly as it does today;
 *   - the paths come from `git rev-parse --show-prefix`, so they are correct
 *     whatever `opencode.config_dir` the manifest chose, and the whole thing
 *     no-ops when the config dir is the out-of-repo default.
 *
 * Never throws: a failure just leaves the noise in place, which is the state
 * this function inherited.
 */
/**
 * One exclude line, or nothing.
 *
 * `.git/info/exclude` is newline-delimited and gives `#` and `!` their own
 * meaning, so a value is only safe to write if every segment is an ordinary
 * path segment. That matters because `prefix` here comes from
 * `git rev-parse --show-prefix`, which follows the repository's own
 * `opencode.config_dir` — repository-controlled input. A crafted value carrying
 * a newline would append EXTRA rules of the attacker's choosing, and an exclude
 * rule hides a file from `git status --porcelain -uall` — the exact command the
 * product uses to show a user what changed in their session. Hiding a file
 * there is hiding it from the human review step.
 *
 * Anything that is not a plain segment is DROPPED, not escaped: this is
 * boot-time hygiene, and a skill directory that cannot be named safely is one
 * we simply do not exclude. The cost of dropping is cosmetic (the row shows up
 * as a change); the cost of writing it blind is a hidden file.
 */
const SAFE_PATH_SEGMENT = /^[\w .-]+$/

function toExcludeEntry(relativePath: string): string | null {
  const segments = relativePath.replace(/\/+$/, '').split('/').filter(Boolean)
  if (segments.length === 0) return null
  if (!segments.every((segment) => SAFE_PATH_SEGMENT.test(segment))) return null
  return `/${segments.join('/')}/`
}

async function excludeInjectedSkillsFromGit(
  skillsDir: string,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: skillsDir,
        timeout: 10_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
      return stdout.trim()
    } catch {
      return null
    }
  }
  // Not a git working tree (the out-of-repo default config dir) → nothing to do.
  const toplevel = await git(['rev-parse', '--show-toplevel'])
  if (!toplevel) return
  // Repo-relative location of the skills dir, WITH a trailing slash when nested.
  // Taken from git rather than computed with path.relative so a symlinked
  // workspace root cannot turn it into a `../..` escape.
  const prefix = (await git(['rev-parse', '--show-prefix'])) ?? ''
  const excludeRelative = await git(['rev-parse', '--git-path', 'info/exclude'])
  if (!excludeRelative) return
  const excludePath = resolve(skillsDir, excludeRelative)

  const wanted = [...names]
    .sort()
    .map((name) => toExcludeEntry(`${prefix}${name}`))
    .filter((entry): entry is string => entry !== null)
  if (wanted.length === 0) return
  let existing = ''
  try {
    existing = await readFile(excludePath, 'utf8')
  } catch {
    existing = '' // no exclude file yet
  }
  const present = new Set(existing.split(/\r?\n/))
  const missing = wanted.filter((entry) => !present.has(entry))
  if (missing.length === 0) return

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  const header = '# Kortix-managed skills — injected at boot, never committed.\n'
  await writeFile(excludePath, `${existing}${separator}${header}${missing.join('\n')}\n`, 'utf8')
  logger.info('[boot] excluded injected managed skills from git status', {
    excludePath,
    entries: missing.length,
  })
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Always-inject the Kortix system skills into the session's OpenCode skills dir.
 *
 * `kortix-cli` (and the rest of the `kortix-*` family) is the one thing Kortix
 * guarantees to every agent: it must be present AND current no matter what the
 * project repo contains — even if the committed copy was edited or deleted, and
 * even for an old project cloned months ago. We overlay the image-baked bodies
 * into `<configDir>/skills/` at boot (force-overwrite), so a stale repo copy is
 * refreshed to the latest and a missing one is restored. This is what keeps
 * projects from ever going stale on Kortix internals.
 *
 * Defensive by design: never throws (a failure just leaves the repo's own copy
 * in place), and no-ops when the baked dir is absent (e.g. a pre-bake image) —
 * exactly like `ensureOpencodeConfigDeps`, which it's called right after.
 */
export async function ensureInjectedManagedSkills(
  configDir: string,
  opts: { bakedDir?: string } = {},
): Promise<void> {
  const bakedDir = opts.bakedDir ?? BAKED_MANAGED_SKILLS_DIR
  try {
    if (!(await pathExists(bakedDir))) return // nothing baked → leave repo copies as-is
    const skillsDir = join(configDir, 'skills')
    const entries = await readdir(bakedDir, { withFileTypes: true })
    const injectedNames: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await cp(join(bakedDir, entry.name), join(skillsDir, entry.name), {
        recursive: true,
        force: true, // overwrite → the injected body always wins over the repo copy
      })
      injectedNames.push(entry.name)
    }
    if (injectedNames.length > 0) {
      logger.info('[boot] injected managed kortix skills', {
        configDir,
        from: bakedDir,
        injected: injectedNames.length,
      })
      await excludeInjectedSkillsFromGit(skillsDir, injectedNames)
    }
  } catch (err) {
    // Non-fatal: the repo's own copy (if any) stays in place.
    logger.warn('[boot] managed-skill injection skipped', { configDir, err: String(err) })
  }
}
