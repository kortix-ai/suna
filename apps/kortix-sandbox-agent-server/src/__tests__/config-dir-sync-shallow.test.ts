/**
 * The boot clone is `--depth 1` and the background unshallow is allowed to fail,
 * so a session can live its whole life on a shallow repository. Every property
 * of `syncOpencodeConfigDirToBase` that reads history has to hold there too.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config'
import { syncOpencodeConfigDirToBase } from '../git'

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
function commit(repo: string, message: string) {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', message)
}
const cfg = () => ({ projectTarget: work, defaultBranch: 'main', repoUrl: `file://${origin}` }) as unknown as Config
const agentText = () => readFileSync(join(work, AGENT), 'utf8')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-cfgdir-shallow-'))
  origin = join(root, 'origin')
  work = join(root, 'work')
  mkdirSync(origin, { recursive: true })
  git(origin, 'init', '--initial-branch=main', '--quiet')
  git(origin, 'config', 'user.email', 't@t.co')
  git(origin, 'config', 'user.name', 'T')
  // Real history behind the boot commit, so depth 1 actually truncates something.
  for (const n of [1, 2, 3]) {
    write(origin, AGENT, `PROMPT v${n}\n`)
    write(origin, 'app.ts', `export const x = ${n}\n`)
    commit(origin, `history ${n}`)
  }
  // `file://` is required: a plain path clone ignores --depth.
  git(root, 'clone', '--quiet', '--depth', '1', `file://${origin}`, work)
  git(work, 'config', 'user.email', 't@t.co')
  git(work, 'config', 'user.name', 'T')
  git(work, 'checkout', '-q', '-b', 'ses-1111-2222')
  expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('true')

  write(origin, AGENT, 'PROMPT v4\n')
  commit(origin, 'base moves')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('config-dir sync on a shallow boot clone', () => {
  test('an untouched session syncs', async () => {
    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })
    expect(agentText()).toBe('PROMPT v4\n')
  })

  test('it syncs again after base moves again', async () => {
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)
    write(origin, AGENT, 'PROMPT v5\n')
    commit(origin, 'base moves again')

    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })
    expect(agentText()).toBe('PROMPT v5\n')
  })

  test('session commits OUTSIDE the config dir do not block it', async () => {
    write(work, 'feature.ts', 'export const f = 1\n')
    commit(work, 'session work')

    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })
  })

  test('`git add -A` after a sync does not lock the session out', async () => {
    await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)
    write(work, 'feature.ts', 'export const f = 1\n')
    commit(work, 'agent: git add -A')
    write(origin, AGENT, 'PROMPT v5\n')
    commit(origin, 'base moves again')

    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({ synced: true })
    expect(agentText()).toBe('PROMPT v5\n')
  })

  test('a real committed config edit still refuses', async () => {
    write(work, AGENT, 'MY PROMPT\n')
    commit(work, 'my prompt')

    expect(await syncOpencodeConfigDirToBase(cfg(), CONFIG_DIR)).toEqual({
      synced: false,
      skipped: 'local commits',
    })
    expect(agentText()).toBe('MY PROMPT\n')
  })
})
