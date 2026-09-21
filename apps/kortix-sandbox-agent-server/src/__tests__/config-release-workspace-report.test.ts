/**
 * The workspace report: the session's work under the config dir, read with
 * read-only Git. Real repositories, full and `--depth 1`. The report never
 * fetches and lists platform-written files too; the API classifies them.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWorkspaceReport } from '../config-release/workspace-report'
import { commitAll, git, initRepo, write } from './helpers/config-release-fixtures'

const DIR = '.kortix/opencode'
let root: string

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function setup(opts: { shallow: boolean }) {
  root = mkdtempSync(join(tmpdir(), 'kortix-ws-report-'))
  const origin = join(root, 'origin')
  const work = join(root, 'work')
  initRepo(origin)
  for (const n of [1, 2]) {
    write(origin, 'app.ts', `export const x = ${n}\n`)
    commitAll(origin, `history ${n}`)
  }
  write(origin, `${DIR}/opencode.jsonc`, '{}\n')
  write(origin, `${DIR}/agents/kortix.md`, 'PROMPT\n')
  write(origin, `${DIR}/package.json`, '{"dependencies":{"@opencode-ai/plugin":"1.17.11"}}\n')
  write(origin, 'README.md', 'outside the config dir\n')
  commitAll(origin, 'base')
  git(root, 'clone', '--quiet', ...(opts.shallow ? ['--depth', '1'] : []), `file://${origin}`, work)
  git(work, 'config', 'user.email', 't@t.co')
  git(work, 'config', 'user.name', 'T')
  git(work, 'checkout', '-q', '-b', 'ses-1')
  return { origin, work }
}

const hashObject = (repo: string, path: string) => git(repo, 'hash-object', '--', path)

for (const shallow of [false, true]) {
  describe(`buildWorkspaceReport (${shallow ? '--depth 1 clone' : 'full clone'})`, () => {
    test('an untouched session reports HEAD and no changes', async () => {
      const { work } = setup({ shallow })
      const report = await buildWorkspaceReport(work, DIR, 'main')
      expect(report).toEqual({ head: git(work, 'rev-parse', 'HEAD'), config_dir: DIR, committed_scope: 'remote', changed: [] })
    })

    test('uncommitted edits, untracked files and deletions, each with its working-tree blob', async () => {
      const { work } = setup({ shallow })
      write(work, `${DIR}/agents/kortix.md`, 'EDITED\n')
      write(work, `${DIR}/skills/new/SKILL.md`, 'NEW SKILL\n')
      unlinkSync(join(work, DIR, 'opencode.jsonc'))
      write(work, 'README.md', 'edited outside the config dir\n')
      const report = await buildWorkspaceReport(work, DIR, 'main')
      expect(report!.changed).toEqual([
        { path: `${DIR}/agents/kortix.md`, status: 'modified', blob: hashObject(work, `${DIR}/agents/kortix.md`) },
        { path: `${DIR}/opencode.jsonc`, status: 'deleted', blob: null },
        { path: `${DIR}/skills/new/SKILL.md`, status: 'untracked', blob: hashObject(work, `${DIR}/skills/new/SKILL.md`) },
      ])
    })

    test("an agent's `git add -A` commit is reported, platform files included", async () => {
      const { work } = setup({ shallow })
      // What a real boot writes: the installer moves the plugin pin, the
      // managed overlay writes a skill. The agent then sweeps both into a commit.
      write(work, `${DIR}/package.json`, '{"dependencies":{"@opencode-ai/plugin":"1.18.23"}}\n')
      write(work, `${DIR}/skills/kortix-cli/SKILL.md`, 'OVERLAY\n')
      write(work, `${DIR}/agents/kortix.md`, 'SESSION PROMPT\n')
      commitAll(work, 'agent: git add -A')
      const report = await buildWorkspaceReport(work, DIR, 'main')
      expect(report!.head).toBe(git(work, 'rev-parse', 'HEAD'))
      expect(report!.changed).toEqual([
        { path: `${DIR}/agents/kortix.md`, status: 'modified', blob: hashObject(work, `${DIR}/agents/kortix.md`) },
        { path: `${DIR}/package.json`, status: 'modified', blob: hashObject(work, `${DIR}/package.json`) },
        { path: `${DIR}/skills/kortix-cli/SKILL.md`, status: 'added', blob: hashObject(work, `${DIR}/skills/kortix-cli/SKILL.md`) },
      ])
    })

    test('a committed file edited again stays added; a committed file removed later is deleted', async () => {
      const { work } = setup({ shallow })
      write(work, `${DIR}/tools/a.ts`, 'export default 1\n')
      write(work, `${DIR}/tools/b.ts`, 'export default 2\n')
      commitAll(work, 'tools')
      write(work, `${DIR}/tools/a.ts`, 'export default 3\n')
      unlinkSync(join(work, DIR, 'tools/b.ts'))
      const report = await buildWorkspaceReport(work, DIR, 'main')
      expect(report!.changed).toEqual([
        { path: `${DIR}/tools/a.ts`, status: 'added', blob: hashObject(work, `${DIR}/tools/a.ts`) },
        { path: `${DIR}/tools/b.ts`, status: 'deleted', blob: null },
      ])
    })

    test('never fetches: a base move on the remote leaves the local repository untouched', async () => {
      const { origin, work } = setup({ shallow })
      write(origin, `${DIR}/agents/kortix.md`, 'BASE MOVED\n')
      const moved = commitAll(origin, 'base moves')
      const trackingBefore = git(work, 'rev-parse', 'refs/remotes/origin/main')
      write(work, `${DIR}/agents/kortix.md`, 'EDITED\n')
      const statusBefore = git(work, 'status', '--porcelain')
      await buildWorkspaceReport(work, DIR, 'main')
      expect(git(work, 'rev-parse', 'refs/remotes/origin/main')).toBe(trackingBefore)
      expect(spawnSync('git', ['-C', work, 'cat-file', '-e', `${moved}^{commit}`]).status).not.toBe(0)
      expect(git(work, 'status', '--porcelain')).toBe(statusBefore)
    })
  })
}

describe('buildWorkspaceReport edge cases', () => {
  test('without a local origin ref, only uncommitted work is reported', async () => {
    root = mkdtempSync(join(tmpdir(), 'kortix-ws-report-'))
    const repo = join(root, 'repo')
    initRepo(repo)
    write(repo, `${DIR}/agents/kortix.md`, 'PROMPT\n')
    commitAll(repo, 'base')
    write(repo, `${DIR}/agents/other.md`, 'COMMITTED\n')
    commitAll(repo, 'session commit')
    write(repo, `${DIR}/agents/kortix.md`, 'EDITED\n')
    const report = await buildWorkspaceReport(repo, DIR, 'main')
    expect(report!.changed.map((change) => change.path)).toEqual([`${DIR}/agents/kortix.md`])
  })

  test('a symlink is hashed by its target text, as Git stores it', async () => {
    const { work } = setup({ shallow: false })
    symlinkSync('agents/kortix.md', join(work, DIR, 'link.md'))
    const report = await buildWorkspaceReport(work, DIR, 'main')
    git(work, 'add', '--', `${DIR}/link.md`)
    const staged = git(work, 'ls-files', '-s', '--', `${DIR}/link.md`).split(' ')[1]
    expect(report!.changed).toEqual([{ path: `${DIR}/link.md`, status: 'untracked', blob: staged! }])
  })

  test('a non-literal config dir is refused before any Git call', async () => {
    const { work } = setup({ shallow: false })
    for (const dir of [':(top)*', '../x', '/abs', '.kortix/../x', '-rf']) {
      await expect(buildWorkspaceReport(work, dir, 'main')).rejects.toThrow(/plain relative path/)
    }
  })

  test('no repository answers null', async () => {
    root = mkdtempSync(join(tmpdir(), 'kortix-ws-report-'))
    expect(await buildWorkspaceReport(root, DIR, 'main')).toBeNull()
  })
})

/**
 * Committed session work must be found in every checkout shape the daemon
 * boots. A fresh boot runs no in-box `git fetch` (compiled checkout, API delta
 * bundle, local session branch), so `refs/remotes/origin/<base>` can be
 * missing or left at the image scaffold's root. Without a base commit the
 * report said "no committed work", the API answered follow-base, and the
 * release shadowed the session's own agent edit.
 */
describe('committed work in every checkout shape', () => {
  const AGENT_EDIT = { path: `${DIR}/agents/kortix.md`, status: 'modified' as const }

  function projectBase(repo: string): string {
    write(repo, `${DIR}/opencode.jsonc`, '{}\n')
    write(repo, `${DIR}/agents/kortix.md`, 'PROMPT\n')
    write(repo, `${DIR}/skills/project/SKILL.md`, 'PROJECT SKILL\n')
    return commitAll(repo, 'project base')
  }

  function commitAgentEdit(repo: string): void {
    write(repo, `${DIR}/agents/kortix.md`, 'SESSION PROMPT\n')
    commitAll(repo, 'agent edits its prompt')
  }

  test('full clone with the remote ref (also the project-seed adoption shape): scope remote', async () => {
    const { work } = setup({ shallow: true })
    // Seed adoption: `remote set-url` + `checkout -B <session>` on the baked clone.
    git(work, 'remote', 'set-url', 'origin', 'https://api.example/v1/git/p.git')
    git(work, 'checkout', '-q', '-B', 'ses-2')
    commitAgentEdit(work)
    const report = await buildWorkspaceReport(work, DIR, 'main', { baseSha: git(work, 'rev-parse', 'HEAD~1') })
    expect(report!.committed_scope).toBe('base-sha')
    expect(report!.changed).toEqual([{ ...AGENT_EDIT, blob: git(work, 'hash-object', '--', AGENT_EDIT.path) }])
    const withoutPin = await buildWorkspaceReport(work, DIR, 'main')
    expect(withoutPin!.committed_scope).toBe('remote')
    expect(withoutPin!.changed.map((c) => c.path)).toEqual([AGENT_EDIT.path])
  })

  test('fresh-boot shape: local session branch at KORTIX_BASE_SHA, no origin ref: scope base-sha', async () => {
    root = mkdtempSync(join(tmpdir(), 'kortix-ws-report-'))
    const work = join(root, 'work')
    initRepo(work)
    const baseSha = projectBase(work)
    // Compiled checkout / delta bundle: origin is set, nothing was fetched.
    git(work, 'remote', 'add', 'origin', 'https://api.example/v1/git/p.git')
    git(work, 'checkout', '-q', '-b', 'ses-3')
    commitAgentEdit(work)
    expect(spawnSync('git', ['-C', work, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main']).status).not.toBe(0)

    const report = await buildWorkspaceReport(work, DIR, 'main', { baseSha })
    expect(report!.committed_scope).toBe('base-sha')
    expect(report!.changed).toEqual([{ ...AGENT_EDIT, blob: git(work, 'hash-object', '--', AGENT_EDIT.path) }])

    // Without the pin the gap is visible, not silent.
    write(work, `${DIR}/agents/draft.md`, 'UNCOMMITTED\n')
    const blind = await buildWorkspaceReport(work, DIR, 'main')
    expect(blind!.committed_scope).toBe('none')
    expect(blind!.changed.map((c) => c.path)).toEqual([`${DIR}/agents/draft.md`])
  })

  test('scaffold shape: origin ref at the scaffold root, project delta applied locally: scope base-sha', async () => {
    root = mkdtempSync(join(tmpdir(), 'kortix-ws-report-'))
    const scaffold = join(root, 'scaffold')
    const work = join(root, 'work')
    initRepo(scaffold)
    write(scaffold, `${DIR}/opencode.jsonc`, '{}\n')
    write(scaffold, `${DIR}/agents/kortix.md`, 'STARTER PROMPT\n')
    commitAll(scaffold, 'starter root')
    // tryScaffoldDeltaFetch: local clone of the baked scaffold, set-url, then
    // the project's delta lands on the local base branch (API bundle).
    git(root, 'clone', '--quiet', scaffold, work)
    git(work, 'config', 'user.email', 't@t.co')
    git(work, 'config', 'user.name', 'T')
    git(work, 'remote', 'set-url', 'origin', 'https://api.example/v1/git/p.git')
    const baseSha = projectBase(work)
    git(work, 'checkout', '-q', '-b', 'ses-4')
    commitAgentEdit(work)

    const report = await buildWorkspaceReport(work, DIR, 'main', { baseSha })
    expect(report!.committed_scope).toBe('base-sha')
    // Only the session's commit: the project's own base commit is not session work.
    expect(report!.changed).toEqual([{ ...AGENT_EDIT, blob: git(work, 'hash-object', '--', AGENT_EDIT.path) }])

    // Measured from the stale scaffold ref alone, base content leaks in.
    const remoteOnly = await buildWorkspaceReport(work, DIR, 'main')
    expect(remoteOnly!.committed_scope).toBe('remote')
    expect(remoteOnly!.changed.map((c) => c.path)).toContain(`${DIR}/skills/project/SKILL.md`)
  })

  test('a KORTIX_BASE_SHA that is not an ancestor of HEAD, or not local, is not used', async () => {
    const { work } = setup({ shallow: false })
    commitAgentEdit(work)
    const foreign = await buildWorkspaceReport(work, DIR, 'main', { baseSha: 'a'.repeat(40) })
    expect(foreign!.committed_scope).toBe('remote')
    git(work, 'checkout', '-q', '-b', 'side', 'HEAD~1')
    write(work, 'other.txt', 'x\n')
    const side = commitAll(work, 'side')
    git(work, 'checkout', '-q', 'ses-1')
    const notAncestor = await buildWorkspaceReport(work, DIR, 'main', { baseSha: side })
    expect(notAncestor!.committed_scope).toBe('remote')
  })
})

/**
 * The API's plugin-pin rule needs the TEXT of `<config dir>/package.json`: an
 * uncommitted or unpushed blob is not in its mirror, and without the text it
 * counts the file as session work. Every box that booted from `/workspace` has
 * the installer's pin edit, so without this no imported sandbox converges.
 * The API uses the text only when its Git blob ID equals the reported blob.
 */
describe('package_json text for the plugin-pin rule', () => {
  const PKG = `${DIR}/package.json`
  const gitBlob = (text: string) =>
    createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')

  test('a pin-only uncommitted edit carries the working-tree text, matching its blob', async () => {
    const { work } = setup({ shallow: true })
    const text = '{"dependencies":{"@opencode-ai/plugin":"1.18.23"}}\n'
    write(work, PKG, text)
    const report = await buildWorkspaceReport(work, DIR, 'main')
    const entry = report!.changed.find((change) => change.path === PKG)!
    expect(entry.status).toBe('modified')
    expect(report!.package_json).toBe(text)
    expect(gitBlob(report!.package_json!)).toBe(entry.blob!)
  })

  test("a pin-only edit swept into a commit by the agent's `git add -A` carries the text", async () => {
    const { work } = setup({ shallow: false })
    const text = '{"dependencies":{"@opencode-ai/plugin":"1.18.23"}}\n'
    write(work, PKG, text)
    write(work, `${DIR}/agents/kortix.md`, 'SESSION PROMPT\n')
    commitAll(work, 'agent: git add -A')
    const report = await buildWorkspaceReport(work, DIR, 'main')
    const entry = report!.changed.find((change) => change.path === PKG)!
    expect(entry.status).toBe('modified')
    expect(report!.package_json).toBe(text)
    expect(gitBlob(report!.package_json!)).toBe(entry.blob!)
  })

  test('a real dependency added carries the text too; the API decides', async () => {
    const { work } = setup({ shallow: false })
    const text = '{"dependencies":{"@opencode-ai/plugin":"1.17.11","zod":"^3.23.8"}}\n'
    write(work, PKG, text)
    const report = await buildWorkspaceReport(work, DIR, 'main')
    expect(report!.package_json).toBe(text)
  })

  test('a deleted package.json reports null; an untouched one omits the field', async () => {
    const { work } = setup({ shallow: false })
    const untouched = await buildWorkspaceReport(work, DIR, 'main')
    expect('package_json' in untouched!).toBe(false)
    write(work, `${DIR}/agents/kortix.md`, 'EDIT\n')
    const otherEdit = await buildWorkspaceReport(work, DIR, 'main')
    expect('package_json' in otherEdit!).toBe(false)
    unlinkSync(join(work, PKG))
    const deleted = await buildWorkspaceReport(work, DIR, 'main')
    expect(deleted!.changed.find((change) => change.path === PKG)).toEqual({ path: PKG, status: 'deleted', blob: null })
    expect(deleted!.package_json).toBeNull()
  })

  test('a package.json over 256 KiB is omitted', async () => {
    const { work } = setup({ shallow: false })
    write(work, PKG, `{"description":"${'x'.repeat(256 * 1024)}"}\n`)
    const report = await buildWorkspaceReport(work, DIR, 'main')
    expect(report!.changed.some((change) => change.path === PKG)).toBe(true)
    expect('package_json' in report!).toBe(false)
  })
})
