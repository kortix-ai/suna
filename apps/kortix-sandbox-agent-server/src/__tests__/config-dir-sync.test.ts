/**
 * `syncOpencodeConfigDirToBase` — the operation a reload actually needs.
 *
 * Context, because the shape of these tests only makes sense with it: opencode
 * is spawned with `OPENCODE_CONFIG_DIR` pointing INTO the working tree, and the
 * agent `.md` files there beat the compiled config the API pushes as JSON.
 * Measured on dev: after a "successful" reload the marker was present in
 * `~/.config/kortix-opencode.json` and absent from opencode's own `/config` and
 * `/agent`. So the reload moved the etag and changed nothing the agent reads.
 *
 * The obvious fix — sync the workspace to base — is the one thing that must not
 * happen. `syncWorkspaceToBase` runs `git checkout -B <branch> <sha>` and
 * `branch` is the SESSION ID, so on a live session it discards the session's own
 * commits. Also reproduced, on a real sandbox.
 *
 * So this function touches ONE pathspec, never moves a ref, and refuses when the
 * session has its own work in that directory. These tests run against real git
 * repositories rather than mocks, because every property that matters here is a
 * property of git's behaviour, not of our control flow.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config'
import { readConfigDirSyncedSha, syncOpencodeConfigDirToBase } from '../git'
import { KORTIX_SERVICE_CALL_HEADER } from '../kortix-user-context'
import type { Opencode } from '../opencode'
import { createRefreshRouter } from '../routes/refresh'

const CONFIG_DIR = '.kortix/opencode'
const AGENT = `${CONFIG_DIR}/agents/kortix.md`

let root: string
let origin: string
let work: string

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function write(repo: string, rel: string, body: string) {
  mkdirSync(join(repo, rel.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(repo, rel), body)
}

function cfg(): Config {
  // Only the fields this function reads. `apiUrl`/`projectId`/`sandboxToken` are
  // deliberately absent so `resolveCloneCredential` short-circuits and no
  // control-plane call is attempted.
  return { projectTarget: work, defaultBranch: 'main', repoUrl: origin } as unknown as Config
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-cfgdir-'))
  origin = join(root, 'origin')
  work = join(root, 'work')

  mkdirSync(origin, { recursive: true })
  git(origin, 'init', '--initial-branch=main', '--quiet')
  git(origin, 'config', 'user.email', 't@t.co')
  git(origin, 'config', 'user.name', 'T')
  write(origin, AGENT, 'ORIGINAL PROMPT\n')
  write(origin, 'app.ts', 'export const x = 1\n')
  git(origin, 'add', '-A')
  git(origin, 'commit', '-qm', 'base')

  git(root, 'clone', '--quiet', origin, work)
  git(work, 'config', 'user.email', 't@t.co')
  git(work, 'config', 'user.name', 'T')
  // A session branch, exactly as the daemon names it.
  git(work, 'checkout', '-q', '-b', 'ses-1111-2222')

  // Base moves on: the agent prompt is edited and merged.
  write(origin, AGENT, 'UPDATED PROMPT\n')
  git(origin, 'add', '-A')
  git(origin, 'commit', '-qm', 'update agent')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const agentText = () => readFileSync(join(work, AGENT), 'utf8')

describe('syncOpencodeConfigDirToBase', () => {
  test('brings the agent config forward to base', async () => {
    expect(agentText()).toBe('ORIGINAL PROMPT\n')

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: true })
    expect(agentText()).toBe('UPDATED PROMPT\n')
  })

  test('it does NOT move the branch, and it keeps the session\'s commits', async () => {
    // The whole reason this function exists instead of `base=1`.
    write(work, 'session-work.ts', 'export const mine = 1\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'session work')
    const head = git(work, 'rev-parse', 'HEAD')

    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(git(work, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(work, 'branch', '--show-current')).toBe('ses-1111-2222')
    expect(readFileSync(join(work, 'session-work.ts'), 'utf8')).toBe('export const mine = 1\n')
    expect(agentText()).toBe('UPDATED PROMPT\n')
  })

  test('it leaves files outside the config dir alone', async () => {
    write(work, 'app.ts', 'export const x = 999\n')

    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('export const x = 999\n')
  })

  test('REFUSES when the session has uncommitted edits to its agent config', async () => {
    // A button labelled "reload config" has no business discarding the config
    // the user is in the middle of writing.
    write(work, AGENT, 'MY WORK IN PROGRESS\n')

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: false, skipped: 'local changes' })
    expect(agentText()).toBe('MY WORK IN PROGRESS\n')
  })

  test('REFUSES when the session COMMITTED its own agent config change', async () => {
    // Committed work is even less discardable than uncommitted work, and a
    // plain `git status` check would miss it entirely.
    write(work, AGENT, 'MY COMMITTED PROMPT\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'my agent tweak')

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: false, skipped: 'local commits' })
    expect(agentText()).toBe('MY COMMITTED PROMPT\n')
  })

  test('preserves a conflicting config commit and unrelated dirty work together', async () => {
    write(work, AGENT, 'SESSION PROMPT\n')
    git(work, 'add', AGENT)
    git(work, 'commit', '-qm', 'session config')
    const head = git(work, 'rev-parse', 'HEAD')
    write(work, 'app.ts', 'export const x = 999\n')
    write(work, 'notes/untracked.txt', 'keep me\n')

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: false, skipped: 'local commits' })
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(work, 'branch', '--show-current')).toBe('ses-1111-2222')
    expect(existsSync(join(work, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(agentText()).toBe('SESSION PROMPT\n')
    expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('export const x = 999\n')
    expect(readFileSync(join(work, 'notes/untracked.txt'), 'utf8')).toBe('keep me\n')
  })

  test('an untracked file under the config dir also blocks it', async () => {
    // `git checkout <sha> -- <dir>` would leave this stranded next to files it
    // did replace, producing a directory that is neither base nor the session.
    write(work, `${CONFIG_DIR}/agents/scratch.md`, 'draft\n')

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: false, skipped: 'local changes' })
  })

  test('reports "already matches base" rather than implying it rewrote files', async () => {
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)
    const second = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(second).toEqual({ synced: false, skipped: 'already matches base' })
  })

  test('leaves the update UNSTAGED, and its diff against base is empty', async () => {
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    // Not staged: the index still matches HEAD.
    expect(git(work, 'diff', '--cached', '--name-only')).toBe('')
    // But the working tree changed.
    expect(git(work, 'diff', '--name-only')).toContain(AGENT)
    // And against base it contributes nothing — so a change request opened from
    // this session carries no spurious config diff.
    expect(git(work, 'diff', '--name-only', 'refs/remotes/origin/main', '--', CONFIG_DIR)).toBe('')
  })

  test('pathspec magic cannot widen the sync beyond the directory', async () => {
    // `opencode.config_dir` is REPO-CONTROLLED and becomes a git pathspec, and
    // git honours magic like `:(top)*` even after `--`. Unguarded, a manifest
    // could turn this into `git checkout <base> -- ':(top)*'` — a rewrite of the
    // whole working tree. Proven below against the real primitive: the same
    // pathspec run WITHOUT the guard does reach outside the directory.
    write(work, 'app.ts', 'export const x = 999\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'local edit outside the config dir')

    const result = await syncOpencodeConfigDirToBase(cfg(), ':(top)*')

    expect(result.synced).toBe(false)
    // Untouched: the file outside the config dir still has the session's content.
    expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('export const x = 999\n')

    // The attack is real without the guard — this is what we are preventing.
    const unguarded = spawnSync(
      'git',
      ['-C', work, 'checkout', 'refs/remotes/origin/main', '--', ':(top)*'],
      { encoding: 'utf8' },
    )
    expect(unguarded.status).toBe(0)
    expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('export const x = 1\n')
  })

  test('a project with no tracked config dir is skipped, not failed', async () => {
    expect(await syncOpencodeConfigDirToBase(cfg(), null)).toEqual({
      synced: false,
      skipped: 'no tracked config dir',
    })
  })

  test('a config dir absent from base is skipped, not failed', async () => {
    const result = await syncOpencodeConfigDirToBase(cfg(), 'does/not/exist')

    expect(result.synced).toBe(false)
    // Either answer is correct and which one you get depends on git's version:
    // an empty pathspec can read as "nothing differs" rather than "no such
    // path". What matters is that it is a SKIP and not a thrown failure.
    expect(result.skipped).toBeDefined()
    expect(['not in base', 'already matches base']).toContain(result.skipped as string)
  })

  test('an explicit base_sha pins which commit is restored', async () => {
    const firstBase = git(origin, 'rev-parse', 'HEAD~1')

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, firstBase)

    // HEAD~1 is the ORIGINAL prompt, which the working tree already has — so the
    // honest answer is "already matches", not a rewrite to the newer tip.
    expect(result).toEqual({ synced: false, skipped: 'already matches base' })
    expect(agentText()).toBe('ORIGINAL PROMPT\n')
  })
})

/**
 * A daemon reboot must never move the session's branch.
 *
 * `checkoutLocalSessionBranch` ran `git checkout -B <branch>` with NO start
 * point, which RESETS the branch to whatever HEAD happens to be. Correct exactly
 * once — creating the branch on a fresh baked checkout — and destructive every
 * other time, because it runs on EVERY daemon boot where /workspace/.git exists.
 *
 * No attacker and nothing unusual is needed. The agent moves HEAD off the
 * session branch (`git checkout main` to diff against base is ordinary), then
 * the box reboots in place — the idle reaper and the proxy's auto-resume both do
 * that with no user action — and every commit the session made is reset away.
 * The command exits 0 and prints only "Switched to and reset branch".
 *
 * The fresh-image guard cannot identify a restart by itself because provider
 * env persists. materializeRepo therefore records one-time checkout adoption
 * in local Git config and also recognizes the existing session ref during the
 * marker rollout.
 *
 * These exercise real git, because the whole defect is a property of what
 * `checkout -B` does versus what `checkout` does.
 */
/**
 * Dev, 2026-09-18, session 6d8dfdae: a session nobody had touched refused its
 * reload with `local changes`. `git status` inside the box named two files, and
 * the platform had written both:
 *
 *   - `package.json` — OpenCode's own installer moved the `@opencode-ai/plugin`
 *     pin from 1.17.11 to 1.18.23 (the pin tracks the opencode BINARY);
 *   - `skills/kortix-cli/SKILL.md` — the managed-skill overlay force-wrote the
 *     current body over the copy the repository tracks.
 *
 * Every starter-seeded repository has this shape, so the guard refused on
 * effectively every session: the etag moved and the agent did not.
 */
describe('platform-written files are not the session\'s work', () => {
  const PKG = `${CONFIG_DIR}/package.json`
  const MANAGED = `${CONFIG_DIR}/skills/kortix-cli/SKILL.md`
  const OWN_SKILL = `${CONFIG_DIR}/skills/my-skill/SKILL.md`
  let overlay: string

  const pkg = (pin: string, extra = '') =>
    `{\n  "dependencies": {\n    "@opencode-ai/plugin": "${pin}"${extra}\n  }\n}\n`
  const opts = () => ({ managedSkillsDir: overlay })

  beforeEach(() => {
    // The repository tracks a package.json, a managed skill and its own skill.
    write(origin, PKG, pkg('1.17.11'))
    write(origin, MANAGED, 'REPO COPY OF KORTIX-CLI\n')
    write(origin, OWN_SKILL, 'MY SKILL v1\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'track deps and skills')
    git(work, 'pull', '-q', 'origin', 'main')

    // The image-baked overlay, as `/opt/kortix/managed-skills` holds it.
    overlay = join(root, 'managed-skills')
    write(overlay, 'kortix-cli/SKILL.md', 'OVERLAY KORTIX-CLI\n')

    // Boot: exactly what the runtime did to the untouched dev session.
    write(work, PKG, pkg('1.18.23'))
    write(work, MANAGED, 'OVERLAY KORTIX-CLI\n')

    // Base moves on.
    write(origin, AGENT, 'NEWER PROMPT\n')
    write(origin, OWN_SKILL, 'MY SKILL v2\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'newer agent + skill')
  })

  test('an untouched session syncs despite the pin and the overlay', async () => {
    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())

    expect(result).toEqual({ synced: true })
    expect(agentText()).toBe('NEWER PROMPT\n')
    expect(readFileSync(join(work, OWN_SKILL), 'utf8')).toBe('MY SKILL v2\n')
  })

  test('the sync keeps the pin and the overlay the platform needs', async () => {
    // Base carries the OLD pin and the OLD skill body. Restoring them would
    // point opencode 1.18.23 at a 1.17.11 plugin and hand the agent stale CLI
    // docs until the next boot.
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())

    expect(readFileSync(join(work, PKG), 'utf8')).toBe(pkg('1.18.23'))
    expect(readFileSync(join(work, MANAGED), 'utf8')).toBe('OVERLAY KORTIX-CLI\n')
  })

  test('a base change to package.json arrives, with the pin still held', async () => {
    write(origin, PKG, pkg('1.17.11', ',\n    "zod": "4.0.0"'))
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'add zod')

    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())

    expect(readFileSync(join(work, PKG), 'utf8')).toBe(pkg('1.18.23', ',\n    "zod": "4.0.0"'))
  })

  test('a lockfile the installer rewrote does not block the sync', async () => {
    // Preview, 2026-09-18: the first sync worked, opencode restarted, its
    // installer rewrote bun.lock for the new pin — and the next sync refused
    // with `local changes`. A lockfile is installer output, not session work.
    const LOCK = `${CONFIG_DIR}/bun.lock`
    write(origin, LOCK, '"@opencode-ai/plugin": "1.17.11"\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'lock')
    git(work, 'pull', '-q', 'origin', 'main')
    write(work, LOCK, '"@opencode-ai/plugin": "1.18.23"\n')
    write(origin, AGENT, 'AFTER THE LOCK\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'after the lock')

    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())).toEqual({ synced: true })
    expect(agentText()).toBe('AFTER THE LOCK\n')

    // The installer runs again after the restart. The next base change still lands.
    write(work, LOCK, '"@opencode-ai/plugin": "1.18.23"\n')
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())).toEqual({
      synced: false,
      skipped: 'already matches base',
    })
    write(origin, AGENT, 'NEWEST PROMPT\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'newest')
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())).toEqual({ synced: true })
    expect(agentText()).toBe('NEWEST PROMPT\n')
  })

  test('a rewritten lockfile next to an EDITED package.json still refuses', async () => {
    write(work, PKG, pkg('1.18.23', ',\n    "left-pad": "1.3.0"'))
    write(work, `${CONFIG_DIR}/bun.lock`, 'left-pad\n')

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())

    expect(result).toEqual({ synced: false, skipped: 'local changes' })
  })

  test('REFUSES when package.json carries more than the pin', async () => {
    write(work, PKG, pkg('1.18.23', ',\n    "left-pad": "1.3.0"'))

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())

    expect(result).toEqual({ synced: false, skipped: 'local changes' })
    expect(agentText()).toBe('UPDATED PROMPT\n')
  })

  test('REFUSES when the session edited a skill the overlay does not own', async () => {
    write(work, OWN_SKILL, 'MY EDITED SKILL\n')

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())

    expect(result).toEqual({ synced: false, skipped: 'local changes' })
    expect(readFileSync(join(work, OWN_SKILL), 'utf8')).toBe('MY EDITED SKILL\n')
  })

  test('with only platform files differing, it reports "already matches base"', async () => {
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())
    const second = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR, undefined, opts())

    expect(second).toEqual({ synced: false, skipped: 'already matches base' })
  })
})

/**
 * A long-lived session outlives many merges to base. The first sync leaves the
 * config dir modified against HEAD — by design, it is unstaged — so a guard that
 * reads `git status` sees the platform's own previous sync as the user's edit
 * and refuses every later one.
 */
describe('a session converges more than once', () => {
  test('a second base change syncs after the first one did', async () => {
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })

    write(origin, AGENT, 'THIRD PROMPT\n')
    write(origin, `${CONFIG_DIR}/agents/reviewer.md`, 'REVIEWER\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'third')
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })
    expect(agentText()).toBe('THIRD PROMPT\n')

    // A file the previous sync ADDED is untracked against HEAD. It is still ours.
    write(origin, `${CONFIG_DIR}/agents/reviewer.md`, 'REVIEWER v2\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'fourth')
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })
    expect(readFileSync(join(work, `${CONFIG_DIR}/agents/reviewer.md`), 'utf8')).toBe('REVIEWER v2\n')
  })

  test('a held pin from the previous sync does not block the next one', async () => {
    const PKG = `${CONFIG_DIR}/package.json`
    const pkg = (pin: string, extra = '') =>
      `{\n  "dependencies": {\n    "@opencode-ai/plugin": "${pin}"${extra}\n  }\n}\n`
    write(origin, PKG, pkg('1.17.11'))
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'deps')
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)
    write(work, PKG, pkg('1.18.23')) // opencode's installer

    write(origin, PKG, pkg('1.17.11', ',\n    "zod": "4.0.0"'))
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'zod')
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })

    write(origin, AGENT, 'FOURTH PROMPT\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'fourth')
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })
    expect(readFileSync(join(work, PKG), 'utf8')).toBe(pkg('1.18.23', ',\n    "zod": "4.0.0"'))
    expect(agentText()).toBe('FOURTH PROMPT\n')
  })

  test('a file the sync ADDED does not make the next call sync again', async () => {
    // Preview, 2026-09-18: three reloads in a row each answered `updated`, and
    // each one restarted opencode. The added file is untracked against the
    // index, and `git diff <ref>` reports such a path as DELETED although the
    // bytes on disk equal the ref's — so "already matches base" never held.
    write(origin, `${CONFIG_DIR}/skills/new-skill/SKILL.md`, 'NEW SKILL\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'add a skill')

    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({
      synced: false,
      skipped: 'already matches base',
    })
  })

  test('the box reports which base commit its config dir represents', async () => {
    // `/kortix/health` serves this; the API diffs it against the base tip.
    expect(await readConfigDirSyncedSha(work)).toBeNull()

    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)
    expect(await readConfigDirSyncedSha(work)).toBe(git(origin, 'rev-parse', 'HEAD'))

    // A base commit outside the config dir changes nothing on disk, and the
    // report still advances — otherwise the box reads as stale forever.
    write(origin, 'app.ts', 'export const x = 2\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'app only')
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({
      synced: false,
      skipped: 'already matches base',
    })
    expect(await readConfigDirSyncedSha(work)).toBe(git(origin, 'rev-parse', 'HEAD'))
  })

  test('a refused sync does NOT advance the report', async () => {
    write(work, AGENT, 'MY WORK IN PROGRESS\n')
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(await readConfigDirSyncedSha(work)).toBeNull()
  })

  test('an edit the session makes AFTER a sync still blocks the next one', async () => {
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)
    write(work, AGENT, 'MY EDIT ON TOP OF THE SYNC\n')
    write(origin, AGENT, 'THIRD PROMPT\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'third')

    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: false, skipped: 'local changes' })
    expect(agentText()).toBe('MY EDIT ON TOP OF THE SYNC\n')
  })

  test('an agent deleted on base is removed from the session', async () => {
    // A retired agent that stays on disk is still offered to the user.
    write(origin, `${CONFIG_DIR}/agents/retired.md`, 'RETIRED\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'add retired')
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)
    expect(existsSync(join(work, `${CONFIG_DIR}/agents/retired.md`))).toBe(true)

    git(origin, 'rm', '-q', `${CONFIG_DIR}/agents/retired.md`)
    git(origin, 'commit', '-qm', 'retire it')
    const result = await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: true })
    expect(existsSync(join(work, `${CONFIG_DIR}/agents/retired.md`))).toBe(false)
  })
})

describe('reboot must not reset an existing session branch', () => {
  test('the destructive primitive really does orphan commits (the bug)', () => {
    // Establishes the danger the fix avoids, so a future reader can see why the
    // extra rev-parse is not ceremony.
    write(work, 'agent-work.txt', 'work\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'agent work')
    const sessionTip = git(work, 'rev-parse', 'HEAD')
    git(work, 'checkout', '-q', 'main')

    git(work, 'checkout', '-B', 'ses-1111-2222')

    expect(git(work, 'rev-parse', 'HEAD')).not.toBe(sessionTip)
    expect(git(work, 'log', '--oneline', '-1')).not.toContain('agent work')
  })

  test('a plain checkout of an EXISTING branch preserves its commits', () => {
    // What the fixed code does instead.
    write(work, 'agent-work.txt', 'work\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'agent work')
    const sessionTip = git(work, 'rev-parse', 'HEAD')
    git(work, 'checkout', '-q', 'main')

    git(work, 'checkout', 'ses-1111-2222')

    expect(git(work, 'rev-parse', 'HEAD')).toBe(sessionTip)
    expect(readFileSync(join(work, 'agent-work.txt'), 'utf8')).toBe('work\n')
  })

  test('the daemon probes for the ref and only creates when it is absent', () => {
    const SRC = readFileSync(join(import.meta.dir, '..', 'git.ts'), 'utf8')
    const fn = SRC.split('async function checkoutLocalSessionBranch(')[1]?.split('\n}\n')[0]
    expect(fn).toBeTruthy()
    expect(fn).toContain("'rev-parse', '--verify', '--quiet'")
    // The existing-ref path must be a plain checkout — `-B` there is the bug.
    const existingPath = (fn as string).slice((fn as string).indexOf('exists.code === 0'));
    expect(existingPath).toContain("'checkout', branch");
    // `-B` may appear EXACTLY once: the create path, reached only when the ref
    // does not exist. A second occurrence means either the existing-ref branch
    // uses it, or a failed switch falls back to it — and that fallback is
    // precisely the data loss.
    expect((fn as string).match(/'-B'/g) ?? []).toHaveLength(1);
  })
})

/**
 * `base=1` is the branch reset. Only the service credential may ask for it.
 *
 * `syncWorkspaceToBase` force-resets the session's own branch onto the base tip
 * and deletes the files its commits introduced. The API's reload deliberately
 * refuses to send it — but the endpoint is reachable through the user-facing
 * sandbox proxy, which blocks exactly one daemon path (`/kortix/env`) and not
 * this one. So any principal who could see the session could wipe its history
 * with a single request, as could the in-box agent via a prompt-injected `curl`
 * against localhost.
 *
 * Its only legitimate caller is the warm-session workspace refresh, at session
 * CREATE, holding the service key.
 */
/**
 * `base=1` — the destructive branch reset — must be unreachable from the proxy.
 *
 * These drive the real Hono route rather than asserting on its source, because
 * the FIRST version of this gate passed a source-shaped test while protecting
 * nothing. It checked only the bearer, and the preview proxy authenticates every
 * request it relays — an ordinary user's included — with the target sandbox's
 * own service key. So `serviceAuthenticated` was true for exactly the traffic
 * the gate existed to stop, and no amount of grepping the file would say so.
 *
 * The shape below named "a proxied user request" is that case, pinned.
 */
describe('base=1 requires a DIRECT service call', () => {
  const TOKEN = 'service-key-under-test'

  function router() {
    // The rejection paths return before any repo or runtime work, so a config
    // carrying just the token is all the route reads on these paths.
    const cfg = { sandboxToken: TOKEN } as unknown as Config
    const opencode = {
      restart: async () => {
        throw new Error('restart must not run on a refused request')
      },
      getState: () => 'ready',
      getPid: () => 1,
    } as unknown as Opencode
    return createRefreshRouter(cfg, opencode)
  }

  async function post(path: string, headers: Record<string, string>) {
    return router().request(path, { method: 'POST', headers })
  }

  test('a request shaped exactly like a proxied user request is refused', async () => {
    // What the proxy actually sends: the sandbox's service key as the bearer,
    // and NO service-call header (it strips that name from every forward).
    // This is the request that used to be accepted.
    const res = await post('/?base=1', { Authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'BASE_RESET_FORBIDDEN' })
  })

  test('the service-call header alone does not authorize it', async () => {
    // The header is unauthenticated on its own — anyone can name a header. It
    // proves the HOP, never the caller, so it must not substitute for the token.
    const res = await post('/?base=1', { [KORTIX_SERVICE_CALL_HEADER]: '1' })
    expect(res.status).toBe(401)
  })

  test('a direct platform call — both proofs — is not refused', async () => {
    const res = await post('/?base=1', {
      Authorization: `Bearer ${TOKEN}`,
      [KORTIX_SERVICE_CALL_HEADER]: '1',
    })
    // It proceeds into the repo work and fails there (this config has no
    // workspace). The assertion that matters is that it was not turned away by
    // the gate — otherwise the warm-session refresh at session create breaks.
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })

  test('the refusal happens before any repo work', async () => {
    // Refusing after the reset would be no protection at all. `syncWorkspaceToBase`
    // would throw on this config; a 403 proves it was never reached.
    const res = await post('/?base=1', { Authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(403)
  })

  test('an ordinary refresh is still open to a proxied caller', async () => {
    // The gate must be specific to the destructive flag. A session owner pulling
    // their own workspace, or the API's reload sending `config_dir=1`, is
    // legitimate and must keep working without the direct-call header.
    for (const path of ['/', '/?restart=0&config_dir=1']) {
      const res = await post(path, { Authorization: `Bearer ${TOKEN}` })
      expect(res.status).not.toBe(403)
    }
  })
})
