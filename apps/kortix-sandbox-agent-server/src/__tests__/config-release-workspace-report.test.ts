/**
 * The workspace report: the session's work under the config dir, read with
 * read-only Git. Real repositories, full and `--depth 1`. The report never
 * fetches and lists platform-written files too; the API classifies them.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
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
      expect(report).toEqual({ head: git(work, 'rev-parse', 'HEAD'), config_dir: DIR, changed: [] })
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
