/**
 * `syncConfigDirToBase` — the operation a reload actually needs.
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
import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { syncConfigDirToBase } from '../git'

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

describe('syncConfigDirToBase', () => {
  test('brings the agent config forward to base', async () => {
    expect(agentText()).toBe('ORIGINAL PROMPT\n')

    const result = await syncConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: true })
    expect(agentText()).toBe('UPDATED PROMPT\n')
  })

  test('it does NOT move the branch, and it keeps the session\'s commits', async () => {
    // The whole reason this function exists instead of `base=1`.
    write(work, 'session-work.ts', 'export const mine = 1\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'session work')
    const head = git(work, 'rev-parse', 'HEAD')

    await syncConfigDirToBase(cfg(), CONFIG_DIR)

    expect(git(work, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(work, 'branch', '--show-current')).toBe('ses-1111-2222')
    expect(readFileSync(join(work, 'session-work.ts'), 'utf8')).toBe('export const mine = 1\n')
    expect(agentText()).toBe('UPDATED PROMPT\n')
  })

  test('it leaves files outside the config dir alone', async () => {
    write(work, 'app.ts', 'export const x = 999\n')

    await syncConfigDirToBase(cfg(), CONFIG_DIR)

    expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('export const x = 999\n')
  })

  test('REFUSES when the session has uncommitted edits to its agent config', async () => {
    // A button labelled "reload config" has no business discarding the config
    // the user is in the middle of writing.
    write(work, AGENT, 'MY WORK IN PROGRESS\n')

    const result = await syncConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: false, skipped: 'local changes' })
    expect(agentText()).toBe('MY WORK IN PROGRESS\n')
  })

  test('REFUSES when the session COMMITTED its own agent config change, touching nothing else', async () => {
    // Committed work is even less discardable than uncommitted work, and a
    // plain `git status` check would miss it entirely. The refusal runs no
    // mutating git: HEAD, the branch, unrelated dirty and untracked files stay.
    write(work, AGENT, 'MY COMMITTED PROMPT\n')
    git(work, 'add', AGENT)
    git(work, 'commit', '-qm', 'my agent tweak')
    const head = git(work, 'rev-parse', 'HEAD')
    write(work, 'app.ts', 'export const x = 999\n')
    write(work, 'notes/untracked.txt', 'keep me\n')

    const result = await syncConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: false, skipped: 'local commits' })
    expect(agentText()).toBe('MY COMMITTED PROMPT\n')
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(work, 'branch', '--show-current')).toBe('ses-1111-2222')
    expect(existsSync(join(work, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('export const x = 999\n')
    expect(readFileSync(join(work, 'notes/untracked.txt'), 'utf8')).toBe('keep me\n')
  })

  test('an untracked file under the config dir also blocks it', async () => {
    // `git checkout <sha> -- <dir>` would leave this stranded next to files it
    // did replace, producing a directory that is neither base nor the session.
    write(work, `${CONFIG_DIR}/agents/scratch.md`, 'draft\n')

    const result = await syncConfigDirToBase(cfg(), CONFIG_DIR)

    expect(result).toEqual({ synced: false, skipped: 'local changes' })
  })

  test('reports "already matches base" rather than implying it rewrote files', async () => {
    await syncConfigDirToBase(cfg(), CONFIG_DIR)
    const second = await syncConfigDirToBase(cfg(), CONFIG_DIR)

    expect(second).toEqual({ synced: false, skipped: 'already matches base' })
  })

  test('leaves the update UNSTAGED, and its diff against base is empty', async () => {
    await syncConfigDirToBase(cfg(), CONFIG_DIR)

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

    const result = await syncConfigDirToBase(cfg(), ':(top)*')

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
    expect(await syncConfigDirToBase(cfg(), null)).toEqual({
      synced: false,
      skipped: 'no tracked config dir',
    })
  })

  test('a config dir absent from base is skipped, not failed', async () => {
    const result = await syncConfigDirToBase(cfg(), 'does/not/exist')

    expect(result.synced).toBe(false)
    // Either answer is correct and which one you get depends on git's version:
    // an empty pathspec can read as "nothing differs" rather than "no such
    // path". What matters is that it is a SKIP and not a thrown failure.
    expect(result.skipped).toBeDefined()
    expect(['not in base', 'already matches base']).toContain(result.skipped as string)
  })

  test('an explicit base_sha pins which commit is restored', async () => {
    const firstBase = git(origin, 'rev-parse', 'HEAD~1')

    const result = await syncConfigDirToBase(cfg(), CONFIG_DIR, firstBase)

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
