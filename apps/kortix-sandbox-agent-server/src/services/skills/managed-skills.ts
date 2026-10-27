import { execFile } from 'node:child_process'
import { access, constants, cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedSkillsDir } from '@/lib/config/managed-skills-dir'
import { logger } from '@/lib/log/logger'
import { enabledFeatureFlags, skillFeatureFlag } from '@/lib/config/feature-flags'

const execFileAsync = promisify(execFile)

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
 * The managed skills whose feature flag (`metadata.kortix-feature-flag`) is off in this box, read
 * from the baked overlay and from the `kortix-*` copies in `skillsDir`. A flag-off box must not
 * have them: a permission deny cannot hide a skill on OpenCode.
 */
export async function withheldManagedSkills(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  bakedDir: string = managedSkillsDir(),
  skillsDir?: string,
): Promise<string[]> {
  const enabled = enabledFeatureFlags(env)
  const dirsOf = async (dir: string, only?: RegExp): Promise<Map<string, string>> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    return new Map(
      entries.filter((e) => e.isDirectory() && (!only || only.test(e.name))).map((e) => [e.name, join(dir, e.name)]),
    )
  }
  const candidates = new Map([...(skillsDir ? await dirsOf(skillsDir, /^kortix-/) : []), ...(await dirsOf(bakedDir))])
  const withheld: string[] = []
  for (const [name, dir] of [...candidates].sort((a, b) => a[0].localeCompare(b[0]))) {
    const body = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => '')
    const flag = skillFeatureFlag(body, name)
    if (flag && !enabled.has(flag)) withheld.push(name)
  }
  return withheld
}

/**
 * Make `skillsDir`, the directory OpenCode reads, match the project's feature flags: remove a
 * withheld managed skill, or copy a flagged one back from the baked overlay when its flag is on.
 * A config release is staged once and reused from disk without the overlay step, so a copy an
 * earlier boot left (or a skill an earlier flag-off boot withheld) survives restarts and env
 * changes; every OpenCode spawn calls this. `unseal` opens a sealed release dir for the write and
 * puts the seal back. Never throws.
 * @deprecated OpenCode only. OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset".
 */
export async function syncFlaggedManagedSkills(
  skillsDir: string,
  opts: { env?: NodeJS.ProcessEnv | Record<string, string | undefined>; unseal?: boolean; bakedDir?: string } = {},
): Promise<void> {
  if (!(await pathExists(skillsDir))) return
  const bakedDir = opts.bakedDir ?? managedSkillsDir()
  const env = opts.env ?? process.env
  const withheld = await withheldManagedSkills(env, bakedDir, skillsDir)
  const flagged = await withheldManagedSkills({}, bakedDir)
  const stale: string[] = []
  for (const name of withheld) if (await pathExists(join(skillsDir, name))) stale.push(name)
  const restore: string[] = []
  for (const name of flagged) {
    if (withheld.includes(name) || (await pathExists(join(skillsDir, name)))) continue
    restore.push(name)
  }
  if (stale.length === 0 && restore.length === 0) return
  const unsealed = opts.unseal ? await execFileAsync('chmod', ['u+w', skillsDir]).then(() => true, () => false) : false
  try {
    for (const name of stale) await removeInjectedSkill(skillsDir, name, opts.unseal === true)
    for (const name of restore) await cp(join(bakedDir, name), join(skillsDir, name), { recursive: true, force: true })
    if (restore.length > 0) await excludeInjectedSkillsFromGit(skillsDir, restore)
  } catch (err) {
    logger.warn('[boot] flagged managed skill not synced', { skillsDir, err: String(err) })
  } finally {
    if (unsealed) await execFileAsync('chmod', ['u-w', skillsDir]).catch(() => undefined)
  }
}

/**
 * Remove a managed skill an earlier boot injected. A copy the project tracks in git is its own and
 * stays; the overlay only ever adds untracked copies (`excludeInjectedSkillsFromGit`).
 */
async function removeInjectedSkill(skillsDir: string, name: string, unseal: boolean): Promise<void> {
  const target = join(skillsDir, name)
  if (!(await pathExists(target))) return
  const tracked = await execFileAsync('git', ['-C', skillsDir, 'ls-files', '--error-unmatch', '--', name]).then(
    () => true,
    () => false,
  )
  if (tracked) return
  try {
    if (unseal) await execFileAsync('chmod', ['-R', 'u+w', target])
    await rm(target, { recursive: true, force: true })
  } catch (err) {
    logger.warn('[boot] withheld managed skill not removed', { target, err: String(err) })
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
 * @deprecated OpenCode only. OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset".
 */
export async function ensureInjectedManagedSkills(
  configDir: string,
  opts: {
    bakedDir?: string
    /**
     * `configDir` is a sealed config release. A release built before the box
     * had an overlay seals a tracked copy of a managed skill read-only (the
     * old-starter shape tracks `skills/kortix-cli`); give the owner write
     * access back before overwriting it. Never set for a working tree.
     */
    unsealManaged?: boolean
    /** The box env. A flagged managed skill is written only while its feature flag is on. */
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  } = {},
): Promise<void> {
  const bakedDir = opts.bakedDir ?? managedSkillsDir()
  // A permission deny cannot hide a skill on OpenCode (the project's config layer merges after the
  // composed config, and its `"*": "allow"` outranks every `skill` rule), so a flag-off box never
  // gets a flagged skill at all.
  const withheld = await withheldManagedSkills(opts.env ?? process.env, bakedDir)
  try {
    if (!(await pathExists(bakedDir))) return // nothing baked → leave repo copies as-is
    const skillsDir = join(configDir, 'skills')
    // A sealed release has `skills/` and its root read-only, so that an agent
    // writing there fails instead of having its file silently reverted by the
    // next verification (`seal`, boot-config.ts). This injection is the one
    // legitimate writer: it opens what it needs and puts the seal straight
    // back, so the hole does not reopen for everyone else.
    const resealed: string[] = []
    if (opts.unsealManaged) {
      for (const dir of [configDir, skillsDir]) {
        if (!(await pathExists(dir))) continue
        await execFileAsync('chmod', ['u+w', dir]).then(
          () => resealed.push(dir),
          () => undefined,
        )
      }
    }
    const entries = await readdir(bakedDir, { withFileTypes: true })
    const injectedNames: string[] = []
    const failed: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const target = join(skillsDir, entry.name)
      if (withheld.includes(entry.name)) {
        await removeInjectedSkill(skillsDir, entry.name, opts.unsealManaged === true)
        continue
      }
      try {
        if (opts.unsealManaged && (await pathExists(target))) {
          await execFileAsync('chmod', ['-R', 'u+w', target])
        }
        await cp(join(bakedDir, entry.name), target, {
          recursive: true,
          force: true, // overwrite → the injected body always wins over the repo copy
        })
        injectedNames.push(entry.name)
      } catch (err) {
        // One unwritable skill must not stop the rest of the family.
        failed.push(`${entry.name}: ${String(err)}`)
      }
    }
    if (failed.length > 0) {
      logger.warn('[boot] managed-skill injection skipped', { configDir, err: failed.join('; ') })
    }
    if (injectedNames.length > 0) {
      logger.info('[boot] injected managed kortix skills', {
        configDir,
        from: bakedDir,
        injected: injectedNames.length,
      })
      await excludeInjectedSkillsFromGit(skillsDir, injectedNames)
    }
    // Deepest first: `skills/` before the root that contains it.
    for (const dir of [...resealed].reverse()) {
      await execFileAsync('chmod', ['u-w', dir]).catch(() => undefined)
    }
  } catch (err) {
    // Non-fatal: the repo's own copy (if any) stays in place.
    logger.warn('[boot] managed-skill injection skipped', { configDir, err: String(err) })
  }
}
