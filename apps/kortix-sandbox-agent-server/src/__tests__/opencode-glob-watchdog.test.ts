import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenCodeGlobWatchdog, GLOB_DEADLINE_MS, isOpenCodeGlobArgv, procStartTicks } from '../opencode-glob-watchdog'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function procFixture() {
  const root = await mkdtemp(join(tmpdir(), 'glob-watchdog-'))
  roots.push(root)
  const add = async (pid: number, parent: number, argv: string[], startTicks: number) => {
    const dir = join(root, String(pid))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'status'), `Name:\trg\nPPid:\t${parent}\n`)
    await writeFile(join(dir, 'cmdline'), argv.join('\0') + '\0')
    // Fields after comm start at state (3); starttime is field 22.
    await writeFile(join(dir, 'stat'), `${pid} (rg worker) S ${Array(18).fill('0').join(' ')} ${startTicks} 0\n`)
  }
  return { root, add }
}

test('recognizes only the built-in glob child command', () => {
  expect(isOpenCodeGlobArgv(['/usr/bin/rg', '--no-config', '--files', '--glob=**/*.pdf', '.'])).toBe(true)
  expect(isOpenCodeGlobArgv(['/usr/bin/rg', '--no-config', '--files', '.'])).toBe(false)
  expect(isOpenCodeGlobArgv(['/usr/bin/rg', '--files', '.'])).toBe(false)
  expect(isOpenCodeGlobArgv(['/bin/bash', '-lc', 'rg --files'])).toBe(false)
  expect(procStartTicks('42 (rg worker) S ' + Array(18).fill('0').join(' ') + ' 987 0')).toBe('987')
})

test('a stalled OpenCode glob ends at the deadline; unrelated processes survive', async () => {
  const fixture = await procFixture()
  await fixture.add(101, 170, ['/usr/bin/rg', '--no-config', '--files', '--glob=**/*.pdf', '.'], 111)
  await fixture.add(102, 171, ['/usr/bin/rg', '--no-config', '--files', '--glob=**/*.pdf', '.'], 112)
  await fixture.add(103, 170, ['/usr/bin/rg', '--files', '.'], 113)
  let at = 1_000
  const signals: Array<[number, string]> = []
  const watchdog = createOpenCodeGlobWatchdog({
    opencodePid: () => 170,
    procRoot: fixture.root,
    now: () => at,
    kill: (pid, signal) => { signals.push([pid, signal]) },
    log: () => {},
  })
  await watchdog.poll()
  at += GLOB_DEADLINE_MS - 1
  await watchdog.poll()
  expect(signals).toEqual([])
  at += 1
  await watchdog.poll()
  expect(signals).toEqual([[101, 'SIGTERM']])
  at += 5_000
  await watchdog.poll()
  expect(signals).toEqual([[101, 'SIGTERM'], [101, 'SIGKILL']])
})

test('PID reuse starts a new deadline', async () => {
  const fixture = await procFixture()
  await fixture.add(101, 170, ['/usr/bin/rg', '--no-config', '--files', '--glob=**/*.pdf', '.'], 111)
  let at = 0
  const signals: Array<[number, string]> = []
  const watchdog = createOpenCodeGlobWatchdog({
    opencodePid: () => 170,
    procRoot: fixture.root,
    now: () => at,
    kill: (pid, signal) => { signals.push([pid, signal]) },
    log: () => {},
  })
  await watchdog.poll()
  at = GLOB_DEADLINE_MS - 1
  await fixture.add(101, 170, ['/usr/bin/rg', '--no-config', '--files', '--glob=**/*.pdf', '.'], 222)
  await watchdog.poll()
  at += 1
  await watchdog.poll()
  expect(signals).toEqual([])
})
