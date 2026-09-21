/**
 * Config convergence — putting opencode on the base branch's CURRENT config
 * without ever writing the session's working tree.
 *
 * History, because the shape of these tests only makes sense with it. opencode
 * reads `OPENCODE_CONFIG_DIR`, and the agent `.md` files there beat the compiled
 * config the API pushes as JSON — so a reload that only pushed JSON moved the
 * etag and changed nothing the agent read. The first fix checked the base
 * branch's config dir out INTO `/workspace`. Measured on real sandboxes, that
 * one decision produced every defect that followed: the platform's own pin,
 * lockfile and skill overlay read as "the session's edits"; the previous sync's
 * unstaged output read as an edit; an agent's `git add -A` swept the synced
 * bytes into a commit, the change request then listed the agent prompt as
 * modified by the session, and the merge CONFLICTED on a file nobody touched.
 *
 * So the working tree is never written. A session with no config work of its
 * own reads a read-only copy of the config dir at the base tip; one that edits
 * its own agent keeps reading `/workspace`. These tests run against real git
 * repositories — full and `--depth 1`, because the boot clone is shallow and
 * its background unshallow is allowed to fail.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBootConfigPointer } from '../boot-config-git'
import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { createOpenCodeControlService } from '../harness/open-code/control'
import { convergeOpencodeConfigDir, resolveActiveOpencodeConfigDir } from '../harness/open-code/config-dir-converge'
import type { Opencode } from '../harness/open-code/lifecycle'
import { createOpenCodeQuickQueueInterrupt } from '../harness/open-code/background'
import { KORTIX_SERVICE_CALL_HEADER } from '../kortix-user-context'
import { createRefreshRouter } from '../routes/refresh'

const CONFIG_DIR = '.kortix/opencode'
const AGENT = `${CONFIG_DIR}/agents/kortix.md`
const PKG = `${CONFIG_DIR}/package.json`
const LOCK = `${CONFIG_DIR}/bun.lock`
const MANAGED = `${CONFIG_DIR}/skills/kortix-cli/SKILL.md`
const OWN_SKILL = `${CONFIG_DIR}/skills/my-skill/SKILL.md`

let root: string
let origin: string
let work: string
let store: string
let overlay: string

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}
function write(repo: string, rel: string, body: string) {
  mkdirSync(join(repo, rel.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(repo, rel), body)
}
function commit(repo: string, message: string): string {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', message)
  return git(repo, 'rev-parse', 'HEAD')
}
const pkg = (pin: string, extra = '') =>
  `{\n  "dependencies": {\n    "@opencode-ai/plugin": "${pin}"${extra}\n  }\n}\n`

function cfg(): Config {
  // Only the fields this path reads. `apiUrl`/`projectId`/`sandboxToken` are
  // deliberately absent so `resolveCloneCredential` short-circuits and no
  // control-plane call is attempted.
  return { projectTarget: work, defaultBranch: 'main', repoUrl: `file://${origin}` } as unknown as Config
}

/** The part of opencode the convergence drives, with a spawn that can decline. */
function fakeOpencode(opts: { decline?: boolean } = {}) {
  const state = { dir: join(work, CONFIG_DIR), reloads: 0 }
  const opencode = {
    useConfigDir(next: string) {
      const previous = state.dir
      state.dir = next
      return previous
    },
    async reloadVerified() {
      state.reloads++
      return opts.decline
        ? { outcome: 'kept-old' as const, reason: 'candidate never served' }
        : { outcome: 'swapped' as const, port: 4097, pid: 2, turnEnded: false }
    },
  } as unknown as Pick<Opencode, 'useConfigDir' | 'reloadVerified'>
  return { opencode, state }
}

function converge(oc: ReturnType<typeof fakeOpencode>, over: { reload?: boolean; relConfigDir?: string | null } = {}) {
  return convergeOpencodeConfigDir({
    cfg: cfg(),
    opencode: oc.opencode,
    relConfigDir: over.relConfigDir === undefined ? CONFIG_DIR : over.relConfigDir,
    workspaceConfigDir: join(work, CONFIG_DIR),
    reload: over.reload ?? true,
    root: store,
    managedSkillsDir: overlay,
    // What the daemon does to a fresh copy, minus the image-baked dependency set.
    prepare: async (staged: string) => {
      cpSync(overlay, join(staged, 'skills'), { recursive: true, force: true })
    },
  })
}

const workspaceAgent = () => readFileSync(join(work, AGENT), 'utf8')
const servedAgent = (oc: ReturnType<typeof fakeOpencode>) => readFileSync(join(oc.state.dir, 'agents/kortix.md'), 'utf8')
const workspaceStatus = () => git(work, 'status', '--porcelain')

function setup(opts: { shallow: boolean }) {
  root = mkdtempSync(join(tmpdir(), 'kortix-converge-'))
  origin = join(root, 'origin')
  work = join(root, 'work')
  store = join(root, 'store')
  overlay = join(root, 'managed-skills')
  mkdirSync(origin, { recursive: true })
  write(overlay, 'kortix-cli/SKILL.md', 'OVERLAY KORTIX-CLI\n')
  git(origin, 'init', '--initial-branch=main', '--quiet')
  git(origin, 'config', 'user.email', 't@t.co')
  git(origin, 'config', 'user.name', 'T')
  // History behind the boot commit, so `--depth 1` truncates something real.
  for (const n of [1, 2]) {
    write(origin, 'app.ts', `export const x = ${n}\n`)
    commit(origin, `history ${n}`)
  }
  write(origin, `${CONFIG_DIR}/opencode.jsonc`, '{}\n')
  write(origin, AGENT, 'ORIGINAL PROMPT\n')
  write(origin, PKG, pkg('1.17.11'))
  write(origin, LOCK, '"@opencode-ai/plugin": "1.17.11"\n')
  write(origin, MANAGED, 'REPO COPY OF KORTIX-CLI\n')
  write(origin, OWN_SKILL, 'MY SKILL v1\n')
  commit(origin, 'base')

  // `file://` is required: a plain path clone ignores --depth.
  git(root, 'clone', '--quiet', ...(opts.shallow ? ['--depth', '1'] : []), `file://${origin}`, work)
  git(work, 'config', 'user.email', 't@t.co')
  git(work, 'config', 'user.name', 'T')
  git(work, 'checkout', '-q', '-b', 'ses-1111-2222') // a session branch, as the daemon names it
  expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe(String(opts.shallow))

  // Base moves on: the agent prompt is edited and merged.
  write(origin, AGENT, 'UPDATED PROMPT\n')
  commit(origin, 'update agent')
}

afterEach(() => {
  spawnSync('chmod', ['-R', 'u+w', root])
  rmSync(root, { recursive: true, force: true })
})

/** What a real boot does to an untouched session (dev, 2026-09-18, session 6d8dfdae). */
function platformDirt() {
  write(work, PKG, pkg('1.18.23')) // opencode's installer moves the pin to match its binary
  write(work, LOCK, '"@opencode-ai/plugin": "1.18.23"\n') // …and rewrites the lockfile for it
  write(work, MANAGED, 'OVERLAY KORTIX-CLI\n') // the managed-skill overlay over a tracked copy
}

for (const shallow of [false, true]) {
  describe(`convergeOpencodeConfigDir (${shallow ? '--depth 1 boot clone' : 'full clone'})`, () => {
    beforeEach(() => setup({ shallow }))

    test('an untouched session is moved onto the base tip — and /workspace is not written', async () => {
      const oc = fakeOpencode()
      const result = await converge(oc)

      expect(result).toMatchObject({ synced: true, sha: git(origin, 'rev-parse', 'HEAD') })
      expect(result.reload).toEqual({ how: 'restarted', turnEnded: false })
      expect(oc.state.dir.startsWith(store)).toBe(true)
      expect(servedAgent(oc)).toBe('UPDATED PROMPT\n')
      // The whole point: nothing for `git status` to see, nothing for an agent's
      // `git add -A` to sweep into a commit, nothing for a change request to carry.
      expect(workspaceAgent()).toBe('ORIGINAL PROMPT\n')
      expect(workspaceStatus()).toBe('')
    })

    test('the platform\'s own writes to /workspace are not the session\'s work', async () => {
      platformDirt()
      const oc = fakeOpencode()

      expect(await converge(oc)).toMatchObject({ synced: true })
      expect(servedAgent(oc)).toBe('UPDATED PROMPT\n')
      // The copy carries the overlay, not the stale body the repository tracks.
      expect(readFileSync(join(oc.state.dir, 'skills/kortix-cli/SKILL.md'), 'utf8')).toBe('OVERLAY KORTIX-CLI\n')
    })

    test('it converges again, and again, as base keeps moving', async () => {
      const oc = fakeOpencode()
      await converge(oc)
      for (const prompt of ['THIRD PROMPT\n', 'FOURTH PROMPT\n']) {
        write(origin, AGENT, prompt)
        commit(origin, prompt.trim())
        expect(await converge(oc)).toMatchObject({ synced: true })
        expect(servedAgent(oc)).toBe(prompt)
      }
      expect(workspaceStatus()).toBe('')
    })

    test('nothing new → nothing extracted and opencode is NOT respawned', async () => {
      const oc = fakeOpencode()
      await converge(oc)
      const again = await converge(oc)

      expect(again).toMatchObject({ synced: false, skipped: 'already matches base' })
      expect(oc.state.reloads).toBe(1)
    })

    test('a skill-only merge converges — the compiled etag cannot see it', async () => {
      const oc = fakeOpencode()
      await converge(oc)
      write(origin, OWN_SKILL, 'MY SKILL v2\n')
      commit(origin, 'skill only')

      expect(await converge(oc)).toMatchObject({ synced: true })
      expect(readFileSync(join(oc.state.dir, 'skills/my-skill/SKILL.md'), 'utf8')).toBe('MY SKILL v2\n')
      expect(oc.state.reloads).toBe(2)
    })

    test('an agent base DELETED is gone from what opencode reads', async () => {
      write(origin, `${CONFIG_DIR}/agents/retired.md`, 'RETIRED\n')
      commit(origin, 'add retired')
      const oc = fakeOpencode()
      await converge(oc)
      expect(existsSync(join(oc.state.dir, 'agents/retired.md'))).toBe(true)

      git(origin, 'rm', '-q', `${CONFIG_DIR}/agents/retired.md`)
      commit(origin, 'retire it')
      await converge(oc)

      expect(existsSync(join(oc.state.dir, 'agents/retired.md'))).toBe(false)
    })

    test('session commits OUTSIDE the config dir never matter', async () => {
      write(work, 'feature.ts', 'export const f = 1\n')
      commit(work, 'session work')
      const oc = fakeOpencode()

      expect(await converge(oc)).toMatchObject({ synced: true })
      expect(readFileSync(join(work, 'feature.ts'), 'utf8')).toBe('export const f = 1\n')
    })

    test('an agent\'s `git add -A` — sweeping in the pin, the lockfile and the overlay — does not count', async () => {
      platformDirt()
      write(work, 'feature.ts', 'export const f = 1\n')
      commit(work, 'agent: git add -A')
      const oc = fakeOpencode()

      expect(await converge(oc)).toMatchObject({ synced: true })
    })

    test('KEEPS /workspace when the session has uncommitted edits to its agent', async () => {
      write(work, AGENT, 'MY WORK IN PROGRESS\n')
      const oc = fakeOpencode()
      const result = await converge(oc)

      expect(result).toMatchObject({ synced: false, skipped: 'local changes', sha: null })
      expect(oc.state.dir).toBe(join(work, CONFIG_DIR))
      expect(oc.state.reloads).toBe(0)
      expect(workspaceAgent()).toBe('MY WORK IN PROGRESS\n')
      expect(await readBootConfigPointer(store)).toBeNull()
    })

    test('KEEPS /workspace when the session COMMITTED its own agent change', async () => {
      write(work, AGENT, 'MY COMMITTED PROMPT\n')
      commit(work, 'my agent tweak')
      const oc = fakeOpencode()

      expect(await converge(oc)).toMatchObject({ synced: false, skipped: 'local commits' })
      expect(oc.state.dir).toBe(join(work, CONFIG_DIR))
    })

    test('a skill the session CREATED is its work too', async () => {
      write(work, `${CONFIG_DIR}/skills/brand-new/SKILL.md`, 'draft\n')
      const oc = fakeOpencode()

      expect(await converge(oc)).toMatchObject({ synced: false, skipped: 'local changes' })
    })

    test('an added dependency is the session\'s work; the pin alone is not', async () => {
      write(work, PKG, pkg('1.18.23', ',\n    "left-pad": "1.3.0"'))
      write(work, LOCK, 'left-pad\n')
      const oc = fakeOpencode()

      expect(await converge(oc)).toMatchObject({ synced: false, skipped: 'local changes' })
    })

    test('a session that STARTS editing its agent is moved back onto its working tree', async () => {
      // Otherwise the copy shadows the edit and "I changed my prompt and nothing
      // happened" becomes a permanent state.
      const oc = fakeOpencode()
      await converge(oc)
      expect(oc.state.dir.startsWith(store)).toBe(true)

      write(work, AGENT, 'NOW I AM EDITING\n')
      const result = await converge(oc)

      expect(result).toMatchObject({ synced: false, skipped: 'local changes', sha: null })
      expect(result.reload).toEqual({ how: 'restarted', turnEnded: false })
      expect(oc.state.dir).toBe(join(work, CONFIG_DIR))
      expect(await readBootConfigPointer(store)).toBeNull()
    })

    test('a box the OLD worktree sync touched is not mistaken for an edited one', async () => {
      // What a pre-refactor daemon left behind: base's bytes, unstaged, in the
      // tracked tree — and then an agent's `git add -A` on top. It is base's
      // content at an earlier commit, read back from base's own history.
      git(work, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main')
      git(work, 'checkout', 'refs/remotes/origin/main', '--', CONFIG_DIR)
      git(work, 'reset', '-q', '--', CONFIG_DIR)
      expect(workspaceStatus()).not.toBe('')
      write(origin, AGENT, 'THIRD PROMPT\n')
      commit(origin, 'third')

      const unstaged = fakeOpencode()
      expect(await converge(unstaged)).toMatchObject({ synced: true })
      expect(servedAgent(unstaged)).toBe('THIRD PROMPT\n')

      commit(work, 'agent: git add -A over the old sync')
      write(origin, AGENT, 'FOURTH PROMPT\n')
      commit(origin, 'fourth')
      const swept = fakeOpencode()
      expect(await converge(swept)).toMatchObject({ synced: true })
      expect(servedAgent(swept)).toBe('FOURTH PROMPT\n')
    })

    test('a replacement opencode that never serves leaves EVERYTHING as it was', async () => {
      const healthy = fakeOpencode()
      await converge(healthy)
      const before = await readBootConfigPointer(store)
      write(origin, AGENT, 'A PROMPT THAT BREAKS BOOT\n')
      commit(origin, 'bad')

      const oc = fakeOpencode({ decline: true })
      oc.state.dir = healthy.state.dir
      const result = await converge(oc)

      expect(result).toMatchObject({ synced: false, skipped: 'reload declined' })
      expect(oc.state.dir).toBe(healthy.state.dir)
      expect(await readBootConfigPointer(store)).toEqual(before)
    })

    test('without a reload the copy is staged for the next spawn', async () => {
      const oc = fakeOpencode()
      const result = await converge(oc, { reload: false })

      expect(result).toMatchObject({ synced: true })
      expect(result.reload).toBeUndefined()
      expect(oc.state.reloads).toBe(0)
      expect((await readBootConfigPointer(store))?.sha).toBe(git(origin, 'rev-parse', 'HEAD'))
    })

    test('a branch that already carries the tip\'s config has nothing to extract', async () => {
      git(work, 'pull', '-q', 'origin', 'main')
      const oc = fakeOpencode()

      expect(await converge(oc)).toMatchObject({ synced: false, skipped: 'already matches base', sha: null })
      expect(oc.state.dir).toBe(join(work, CONFIG_DIR))
    })

    test('a project with no tracked config dir is skipped, not failed', async () => {
      expect(await converge(fakeOpencode(), { relConfigDir: null })).toMatchObject({
        synced: false,
        skipped: 'no tracked config dir',
      })
    })

    test('a config dir absent from base is skipped, not failed', async () => {
      git(origin, 'rm', '-rq', CONFIG_DIR)
      commit(origin, 'base drops its config')
      git(work, 'rm', '-rq', CONFIG_DIR)
      commit(work, 'gone here too')

      expect(await converge(fakeOpencode())).toMatchObject({ synced: false })
    })

    test('pathspec magic in a repo-controlled config dir reaches nothing', async () => {
      const oc = fakeOpencode()
      const result = await converge(oc, { relConfigDir: ':(top)*' })

      expect(result.synced).toBe(false)
      expect(oc.state.dir).toBe(join(work, CONFIG_DIR))
      expect(workspaceStatus()).toBe('')
      expect(existsSync(store) ? await readBootConfigPointer(store) : null).toBeNull()
    })
  })
}

describe('resolveActiveOpencodeConfigDir — which directory a restarted daemon spawns on', () => {
  beforeEach(() => setup({ shallow: true }))
  const resolveActive = () =>
    resolveActiveOpencodeConfigDir({
      cfg: cfg(),
      workspaceConfigDir: join(work, CONFIG_DIR),
      root: store,
      managedSkillsDir: overlay,
      prepare: async (staged: string) => {
        cpSync(overlay, join(staged, 'skills'), { recursive: true, force: true })
      },
    })

  test('a box that never converged runs its working tree', async () => {
    expect(await resolveActive()).toEqual({ dir: join(work, CONFIG_DIR), sha: null })
  })

  test('a converged box comes back on its copy — a resume restarts the daemon', async () => {
    const oc = fakeOpencode()
    await converge(oc)

    expect(await resolveActive()).toEqual({ dir: oc.state.dir, sha: git(origin, 'rev-parse', 'HEAD') })
  })

  test('a tampered copy is rebuilt before opencode ever reads it', async () => {
    const oc = fakeOpencode()
    await converge(oc)
    chmodSync(join(oc.state.dir, 'agents/kortix.md'), 0o644)
    writeFileSync(join(oc.state.dir, 'agents/kortix.md'), 'INJECTED PROMPT\n')

    const active = await resolveActive()

    expect(active.dir).toBe(oc.state.dir)
    expect(readFileSync(join(active.dir, 'agents/kortix.md'), 'utf8')).toBe('UPDATED PROMPT\n')
  })

  test('a copy that cannot be rebuilt drops the box onto its working tree', async () => {
    const oc = fakeOpencode()
    await converge(oc)
    spawnSync('chmod', ['-R', 'u+w', store])
    rmSync(oc.state.dir, { recursive: true, force: true })
    // The commit is gone too: nothing to rebuild from.
    writeFileSync(
      join(store, 'current.json'),
      JSON.stringify({ sha: 'a'.repeat(40), relConfigDir: CONFIG_DIR, dir: join(store, 'a'.repeat(40)) }),
    )

    expect(await resolveActive()).toEqual({ dir: join(work, CONFIG_DIR), sha: null })
    expect(await readBootConfigPointer(store)).toBeNull()
  })
})

/**
 * Preview, 2026-09-18: a merge that touched ONLY a skill body changed nothing the
 * agent saw, while the API answered "the next prompt runs the new config". Same
 * opencode pid before and after. The env push restarts opencode only when the
 * env it carries changed, and a skill body is not in it — so the respawn belongs
 * with the one step that knows the directory moved.
 */
describe('POST /kortix/refresh?config_dir=1', () => {
  const TOKEN = 'service-key-under-test'
  let previousRoot: string | undefined
  let previousOverlay: string | undefined

  beforeEach(() => {
    setup({ shallow: true })
    previousRoot = process.env.KORTIX_BOOT_CONFIG_ROOT
    process.env.KORTIX_BOOT_CONFIG_ROOT = store
    // The route passes no overlay dir — production resolves the default. Point
    // the default at a real overlay so this exercises what a sandbox runs.
    previousOverlay = process.env.KORTIX_MANAGED_SKILLS_DIR
    process.env.KORTIX_MANAGED_SKILLS_DIR = overlay
    write(overlay, 'kortix-system/SKILL.md', 'NOT IN THE REPO\n')
  })
  afterEach(() => {
    if (previousRoot === undefined) delete process.env.KORTIX_BOOT_CONFIG_ROOT
    else process.env.KORTIX_BOOT_CONFIG_ROOT = previousRoot
    if (previousOverlay === undefined) delete process.env.KORTIX_MANAGED_SKILLS_DIR
    else process.env.KORTIX_MANAGED_SKILLS_DIR = previousOverlay
  })

  function harness() {
    const oc = fakeOpencode()
    const opencode = {
      ...oc.opencode,
      getState: () => 'starting', // keeps the detached runtime-assets pass out of the test
      getPid: () => 1,
    } as unknown as Opencode
    const config = {
      ...cfg(),
      sandboxToken: TOKEN,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
      defaultOpencodeConfigDir: join(root, 'default-config'),
    } as unknown as Config
    const control = createOpenCodeControlService(
      opencode,
      createOpenCodeQuickQueueInterrupt(opencode, config),
    ).bind({ cfg: config })
    const post = (query: string) =>
      createRefreshRouter(config, control).request(`/?${query}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    return { oc, post }
  }

  test('reload_if_synced=1 respawns once when the directory moved, and reports it', async () => {
    const h = harness()
    const res = await h.post('restart=0&config_dir=1&reload_if_synced=1')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.config_dir).toEqual({ synced: true })
    expect(body.config_dir_reload).toEqual({ how: 'restarted', turn_ended: false })
    expect(h.oc.state.reloads).toBe(1)
    expect(workspaceStatus()).toBe('')
  })

  test('nothing moved → nothing respawned', async () => {
    const h = harness()
    await h.post('restart=0&config_dir=1&reload_if_synced=1')
    const again = await h.post('restart=0&config_dir=1&reload_if_synced=1')

    const body = (await again.json()) as Record<string, unknown>
    expect(body.config_dir).toEqual({ synced: false, skipped: 'already matches base' })
    expect(body.config_dir_reload).toBeUndefined()
    expect(h.oc.state.reloads).toBe(1)
  })

  test('without the flag the copy is staged and opencode is left alone', async () => {
    const h = harness()
    const res = await h.post('restart=0&config_dir=1')

    expect(((await res.json()) as Record<string, unknown>).config_dir).toEqual({ synced: true })
    expect(h.oc.state.reloads).toBe(0)
  })
})

describe('reboot must not reset an existing session branch', () => {
  beforeEach(() => setup({ shallow: false }))

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
    const cfg = { sandboxToken: TOKEN, opencodeInternalPort: 4096, opencodeStandbyPort: 4097, defaultOpencodeConfigDir: '/ephemeral/opencode' } as unknown as Config
    const opencode = {
      restart: async () => {
        throw new Error('restart must not run on a refused request')
      },
      getState: () => 'ready',
      getPid: () => 1,
    } as unknown as Opencode
    return createRefreshRouter(cfg, createOpenCodeControlService(opencode, createOpenCodeQuickQueueInterrupt(opencode, cfg)).bind({ cfg }))
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
