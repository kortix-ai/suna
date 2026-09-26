/**
 * The OpenCode process lifecycle, proven on real processes.
 *
 * Every row spawns a fake `opencode` (a bun script) through the production
 * lifecycle: real ports, real pids, real signals, a real `/session` API. The
 * fake reads its behaviour from files under `<root>/ctl` at request time, so a
 * row can change what the NEXT process or request does:
 *
 *   mode-<port>      '' | 'exit' (exit at once) | '503-then-exit'
 *   session-503      /session answers 503 while the file exists
 *   dispose          'json-true' | 'json-false' | 'html' | absent (404)
 *   slow-term        trap SIGTERM and exit ~1 s later
 *   fork-grandchild  fork `sleep 30` into the process group, pid in grandchild-<pid>
 *
 * and records what it saw: `env-<pid>.json` (the spawn env), `requests-<port>.log`,
 * and `config-at-dispose.json` (the composed config file when dispose arrived).
 *
 * The listening-announcement rows use a second fake that models OpenCode 1.18's
 * bind→handler window on a raw TCP socket.
 *
 * This suite replaced source greps of lifecycle.ts that a pure file rename had
 * to edit and that two real regressions (a candidate verdict that stopped
 * asking `/session`, a recovery that stopped resetting the respawn backoff)
 * passed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import {
  createOpencodeLifecycle,
  waitForOpencodeReady,
  type Opencode,
  type OpencodeLifecycleOptions,
} from '../harness/open-code/lifecycle'
import { createOpenCodeHarnessService } from '../harness/open-code/service'
import { bootLinkPath } from '../boot-config'
import { restoreTestConfigRoot, serveTestConfigDir } from './helpers/boot-link'
import { createProjectEnvStore, type ProjectEnvStore } from '../project-env'

let root: string
let ctl: string
let lifecycle: Opencode | null

const ENV_KEYS = ['KORTIX_COMPILED_RUNTIME_FORMAT', 'KORTIX_CONTINUATION_DISABLED'] as const
const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-opencode-lifecycle-'))
  ctl = join(root, 'ctl')
  mkdirSync(ctl)
  lifecycle = null
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
})

afterEach(async () => {
  restoreTestConfigRoot()
  await lifecycle?.stop()
  for (const pid of grandchildPids()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

// ── helpers ──────────────────────────────────────────────────────────────────

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const port = server.port
  server.stop(true)
  if (typeof port !== 'number') throw new Error('Bun did not assign a port')
  return port
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Real process transitions on a loaded runner: budget 5x the observed event
 * (learnings register) — the conditions themselves are timing-independent.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error('condition did not become true')
}

async function sessionAnswers(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/session`, { signal: AbortSignal.timeout(1_000) })).status === 200
  } catch {
    return false
  }
}

async function portRefuses(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(1_000) })
    return false
  } catch {
    return true
  }
}

function setCtl(name: string, value = ''): void {
  writeFileSync(join(ctl, name), value)
}

function clearCtl(name: string): void {
  rmSync(join(ctl, name), { force: true })
}

function requestLog(port: number): string[] {
  const path = join(ctl, `requests-${port}.log`)
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

function spawnEnv(pid: number): Record<string, string | null> {
  return JSON.parse(readFileSync(join(ctl, `env-${pid}.json`), 'utf8'))
}

function grandchildOf(pid: number): number {
  return Number(readFileSync(join(ctl, `grandchild-${pid}`), 'utf8'))
}

function grandchildPids(): number[] {
  if (!existsSync(ctl)) return []
  return readdirSync(ctl)
    .filter((name) => name.startsWith('grandchild-'))
    .map((name) => Number(readFileSync(join(ctl, name), 'utf8')))
    .filter((pid) => pid > 0)
}

function writeFakeOpencode(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const CTL = ${JSON.stringify(ctl)}
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1])
const flag = (name) => existsSync(CTL + '/' + name)
const read = (name) => (flag(name) ? readFileSync(CTL + '/' + name, 'utf8').trim() : '')
writeFileSync(CTL + '/env-' + process.pid + '.json', JSON.stringify({
  port,
  KORTIX_CONTINUATION_DISABLED: process.env.KORTIX_CONTINUATION_DISABLED ?? null,
  OPENCODE_DISABLE_MODELS_FETCH: process.env.OPENCODE_DISABLE_MODELS_FETCH ?? null,
}))
const mode = read('mode-' + port)
if (mode === 'exit') process.exit(1)
if (flag('fork-grandchild')) {
  const grandchild = spawn('sleep', ['30'], { stdio: 'ignore' })
  writeFileSync(CTL + '/grandchild-' + process.pid, String(grandchild.pid))
}
if (flag('slow-term')) process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1_000))
Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    appendFileSync(CTL + '/requests-' + port + '.log', process.pid + ' ' + req.method + ' ' + url.pathname + url.search + '\\n')
    if (req.method === 'POST' && url.pathname === '/global/dispose') {
      if (process.env.OPENCODE_CONFIG) {
        writeFileSync(CTL + '/config-at-dispose.json', readFileSync(process.env.OPENCODE_CONFIG, 'utf8'))
      }
      const dispose = read('dispose')
      if (dispose === 'json-true') return Response.json(true)
      if (dispose === 'json-false') return Response.json(false)
      if (dispose === 'html') return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
      return new Response('not found', { status: 404 })
    }
    if (url.pathname === '/session') {
      if (mode === '503-then-exit' || flag('session-503')) return new Response('starting', { status: 503 })
      return Response.json([])
    }
    // OpenCode's SPA catch-all answers every unknown path.
    return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
  },
})
console.log('opencode server listening on http://127.0.0.1:' + port)
if (mode === '503-then-exit') setTimeout(() => process.exit(1), 1_500)
`,
  )
  chmodSync(path, 0o755)
}

interface Rig {
  lifecycle: Opencode
  cfg: Config
  primary: number
  standby: number
  binary: string
  /** Every startup mark, with the time it fired. */
  marks: Array<{ label: string; at: number }>
  spawned(): number
}

function rig(
  options: OpencodeLifecycleOptions & { projectEnv?: ProjectEnvStore; binary?: string } = {},
): Rig {
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const binary = options.binary ?? join(root, 'opencode')
  if (!options.binary && !options.binaryPathResolverOverride) writeFakeOpencode(binary)
  const primary = reservePort()
  const standby = reservePort()
  const cfg = {
    workspace,
    projectTarget: workspace,
    opencodeInternalPort: primary,
    opencodeStandbyPort: standby,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
  } as Config
  const marks: Rig['marks'] = []
  const { projectEnv, binary: _binary, ...lifecycleOptions } = options
  const created = createOpencodeLifecycle(cfg, projectEnv, {
    ...(options.binaryPathResolverOverride ? {} : { binaryPathOverride: binary }),
    configPathOverride: join(root, 'runtime-config.json'),
    ...lifecycleOptions,
    onStartupMark: (label) => {
      marks.push({ label, at: Date.now() })
      options.onStartupMark?.(label)
    },
  })
  lifecycle = created
  return {
    lifecycle: created,
    cfg,
    primary,
    standby,
    binary,
    marks,
    spawned: () => marks.filter((mark) => mark.label === 'runtime-process-spawned').length,
  }
}

async function startReady(r: Rig): Promise<number> {
  await r.lifecycle.start()
  expect(await waitForOpencodeReady(r.lifecycle, r.cfg.projectTarget)).toBe(true)
  const pid = r.lifecycle.getPid()
  expect(pid).not.toBeNull()
  return pid as number
}

// ── spawn and readiness ──────────────────────────────────────────────────────

describe('spawn and readiness', () => {
  test('keeps readiness pending across asynchronous spawn errors, then recovery resets the respawn backoff', async () => {
    // A missing binary rejects every spawn asynchronously; the start path must
    // hand that to the respawn loop (it used to log and leave the box down).
    const binary = join(root, 'opencode-missing-at-first')
    let readySettled = false
    const r = rig({
      binary,
      onFirstReadyResponse: () => {
        readySettled = true
      },
    })
    const attempts = () => r.marks.filter((mark) => mark.label === 'runtime-config-ready').length

    await r.lifecycle.start()
    await waitFor(() => attempts() >= 2, 3_000)
    expect(readySettled).toBe(false)
    expect(r.lifecycle.getPid()).toBeNull()

    writeFakeOpencode(binary)
    await waitFor(() => readySettled)
    await waitFor(() => r.lifecycle.getState() === 'ok')
    expect(attempts()).toBeGreaterThanOrEqual(3)

    // The failed attempts doubled the backoff to >= 4 s. Readiness resets it,
    // so the next crash respawns on the 500 ms rung, not the 4 s one.
    const spawnedBefore = r.spawned()
    const killedAt = Date.now()
    process.kill(r.lifecycle.getPid() as number, 'SIGKILL')
    await waitFor(() => r.spawned() > spawnedBefore, 10_000)
    const respawnedAt = r.marks.filter((mark) => mark.label === 'runtime-process-spawned').at(-1)!.at
    expect(respawnedAt - killedAt).toBeLessThan(1_500)
  }, 30_000)

  test('reports the first successful readiness response once', async () => {
    let reports = 0
    setCtl('session-503')
    const r = rig({
      onFirstReadyResponse: () => {
        reports += 1
      },
    })

    await r.lifecycle.start()
    await waitFor(() => requestLog(r.primary).some((line) => line.includes('/session')))
    await Bun.sleep(25)
    expect(reports).toBe(0)

    clearCtl('session-503')
    await waitFor(() => reports === 1)
    await waitFor(() => r.lifecycle.getState() === 'ok')

    setCtl('session-503')
    await r.lifecycle.restart()
    clearCtl('session-503')
    await waitFor(() => r.lifecycle.getState() === 'ok')
    expect(reports).toBe(1)

    setCtl('session-503')
    process.kill(r.lifecycle.getPid() as number, 'SIGKILL')
    await waitFor(() => r.lifecycle.getPid() === null)
    clearCtl('session-503')
    await waitFor(() => r.lifecycle.getState() === 'ok')
    expect(reports).toBe(1)
  }, 90_000)

  test('the spawn env carries the Kortix-managed values over conflicting inputs', async () => {
    // Compiled boot: the binary embeds a models snapshot; a remote refresh is
    // network contention. Passive continuation is a platform decision a
    // project or daemon env value cannot turn back on.
    process.env.KORTIX_COMPILED_RUNTIME_FORMAT = 'kortix.compiled-runtime.v1'
    process.env.KORTIX_CONTINUATION_DISABLED = 'false'
    const r = rig()
    const pid = await startReady(r)

    expect(spawnEnv(pid)).toMatchObject({
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      KORTIX_CONTINUATION_DISABLED: '1',
    })
  }, 30_000)

  test('retries a transient binary lookup miss on the next start', async () => {
    const binary = join(root, 'opencode')
    writeFakeOpencode(binary)
    let lookups = 0
    const r = rig({ binaryPathResolverOverride: async () => (++lookups === 1 ? null : binary) })

    await r.lifecycle.start()
    expect(r.lifecycle.getPid()).toBeNull()
    await r.lifecycle.start()
    expect(r.lifecycle.getPid()).not.toBeNull()
    expect(lookups).toBe(2)
  }, 30_000)

  test('a deferred directory probe sends no directory-scoped request until the workspace is ready', async () => {
    // OpenCode reads a directory's node_modules ONCE per process, on the first
    // directory-scoped request. Before the checkout lands, only a route that
    // creates no Instance may be probed.
    const r = rig({ deferDirectoryProbe: true })
    await r.lifecycle.start()
    await waitFor(() => requestLog(r.primary).some((line) => line.includes('/kortix-liveness-probe')))
    await Bun.sleep(500)
    expect(requestLog(r.primary).filter((line) => line.includes('directory='))).toEqual([])
    expect(r.lifecycle.getState()).toBe('starting')
    // No Instance answered yet: the workspace reload needs no restart.
    expect(await r.lifecycle.reloadForWorkspace()).toBe(true)

    r.lifecycle.markWorkspaceReady()
    await waitFor(() => r.lifecycle.getState() === 'ok')
    expect(requestLog(r.primary).some((line) => line.includes('/session?directory='))).toBe(true)
  }, 30_000)

  test('an Instance that answered before the workspace was ready forces a restart', async () => {
    const r = rig()
    await startReady(r)
    await waitFor(() => requestLog(r.primary).some((line) => line.includes('/session?directory=')))
    // The lifecycle's own probe got a directory-scoped answer: that Instance
    // cached a registry built without the workspace, so dispose is not enough.
    await waitFor(async () => (await r.lifecycle.reloadForWorkspace()) === false, 10_000)
  }, 30_000)
})

// ── listening announcement ───────────────────────────────────────────────────

// OpenCode 1.18 binds its port ~100 ms before its request handler exists
// (Effect NodeHttpServer: listen() in `make`, on("request") in `serve`). A
// request accepted in that window is never answered. It prints `opencode
// server listening on http://…` only after the handler is attached. This fake
// holds every connection accepted in its first `deadMs` (counted in heldFile),
// serves plain HTTP afterwards, and — when `announce` — prints the line once
// the window has closed.
function writeDeadWindowBinary(path: string, deadMs: number, announce: boolean, heldFile: string) {
  writeFileSync(
    path,
    `#!/usr/bin/env bun
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1])
const bound = Date.now()
const held = []
Bun.listen({
  hostname: '127.0.0.1',
  port,
  socket: {
    open(socket) {
      if (Date.now() - bound < ${deadMs}) {
        held.push(socket)
        require('node:fs').appendFileSync(${JSON.stringify(heldFile)}, 'held\\n')
      }
    },
    data(socket, chunk) {
      if (held.includes(socket)) return
      const line = new TextDecoder().decode(chunk).split('\\r\\n')[0]
      const body = line.includes('/session') ? '[]' : 'not found'
      const status = line.includes('/session') ? '200 OK' : '404 Not Found'
      socket.write('HTTP/1.1 ' + status + '\\r\\ncontent-type: application/json\\r\\ncontent-length: ' + body.length + '\\r\\nconnection: close\\r\\n\\r\\n' + body)
      socket.end()
    },
    close() {},
    error() {},
  },
})
${announce ? `setTimeout(() => console.log('opencode server listening on http://127.0.0.1:' + port), ${deadMs})` : ''}
setInterval(() => {}, 60_000)
`,
  )
  chmodSync(path, 0o755)
}

function heldCount(heldFile: string): number {
  if (!existsSync(heldFile)) return 0
  return readFileSync(heldFile, 'utf8').split('\n').filter(Boolean).length
}

describe('listening announcement', () => {
  test('nothing is sent before the announcement; the first probe lands after the window', async () => {
    const binary = join(root, 'opencode-dead-window')
    const heldFile = join(root, 'held.log')
    // 400 ms window: the 100 ms poll would land in it several times.
    writeDeadWindowBinary(binary, 400, true, heldFile)

    let forwarded = ''
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      forwarded += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write
    try {
      const ready = Promise.withResolvers<void>()
      const r = rig({ binary, onFirstReadyResponse: ready.resolve })

      const started = Date.now()
      await r.lifecycle.start()
      await r.lifecycle.waitForCurrentListening()
      const listeningAfterMs = Date.now() - started
      await ready.promise
      const readyAfterMs = Date.now() - started

      // Not one connection reached the port while the handler was missing.
      expect(heldCount(heldFile)).toBe(0)
      // The announcement comes after the window closes: bun startup + 400 ms.
      expect(listeningAfterMs).toBeGreaterThanOrEqual(400)
      // …and readiness follows within one poll interval plus one probe.
      expect(readyAfterMs).toBeLessThan(listeningAfterMs + 1_000)
      expect(r.marks.filter((mark) => mark.label === 'opencode-listening-line')).toHaveLength(1)
      expect(forwarded).toContain('opencode server listening on http://127.0.0.1:')
    } finally {
      process.stdout.write = originalWrite as typeof process.stdout.write
    }
  }, 15_000)

  test('without the announcement the fallback probe still finds the process', async () => {
    const binary = join(root, 'opencode-silent')
    writeDeadWindowBinary(binary, 300, false, join(root, 'held.log'))
    const ready = Promise.withResolvers<void>()
    // The real fallback is 10 s; the point here is only that probing resumes.
    const r = rig({ binary, listeningLineFallbackMs: 200, onFirstReadyResponse: ready.resolve })

    const started = Date.now()
    await r.lifecycle.start()
    await ready.promise
    // The fallback pays for the window (a probe dropped in it waits its 2 s
    // timeout), but the process is found and the listening waiter resolves.
    expect(Date.now() - started).toBeLessThan(6_000)
    await r.lifecycle.waitForCurrentListening()
  }, 15_000)
})

// ── verified reload ──────────────────────────────────────────────────────────

describe('verified reload', () => {
  test('harness service promotes verified candidates, preserves failed reloads, and restarts through lifecycle', async () => {
    const workspace = join(root, 'workspace')
    const binary = join(root, 'opencode')
    mkdirSync(workspace)
    writeFakeOpencode(binary)
    const primary = reservePort()
    const standby = reservePort()
    const cfg = {
      workspace,
      projectTarget: workspace,
      opencodeInternalPort: primary,
      opencodeStandbyPort: standby,
      gitUserName: 'Kortix Agent',
      gitUserEmail: 'agent@kortix.ai',
    } as Config
    let spawned = 0
    const harness = createOpenCodeHarnessService(cfg, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
      onStartupMark: (label) => {
        if (label === 'runtime-process-spawned') spawned += 1
      },
    })

    lifecycle = harness.native
    await harness.lifecycle.start()
    expect(await waitForOpencodeReady(lifecycle, workspace)).toBe(true)
    const initialPid = lifecycle.getPid()
    expect(initialPid).not.toBeNull()
    expect(lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${primary}`)

    const first = await harness.configuration.reloadVerified()
    expect(first.outcome).toBe('swapped')
    if (first.outcome !== 'swapped') throw new Error(first.reason)
    expect(first.port).toBe(standby)
    expect(first.pid).not.toBe(initialPid)
    expect(lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${standby}`)
    await waitFor(() => !processExists(initialPid as number))
    expect(await sessionAnswers(lifecycle.getInternalUrl())).toBe(true)
    await Bun.sleep(650)
    expect(lifecycle.getPid()).toBe(first.pid)

    const second = await harness.configuration.reloadVerified()
    expect(second.outcome).toBe('swapped')
    if (second.outcome !== 'swapped') throw new Error(second.reason)
    expect(second.port).toBe(primary)
    expect(second.pid).not.toBe(first.pid)
    expect(lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${primary}`)
    await waitFor(() => !processExists(first.pid as number))
    await Bun.sleep(650)
    expect(lifecycle.getPid()).toBe(second.pid)

    // Fault injection applies AFTER a real candidate spawn: the decline path
    // spawns, retires the candidate, and leaves the incumbent untouched.
    const activePid = lifecycle.getPid()
    const spawnedBefore = spawned
    const failed = await harness.configuration.reloadVerified({ forceFail: true })
    expect(failed.outcome).toBe('kept-old')
    expect(spawned).toBe(spawnedBefore + 1)
    expect(await portRefuses(standby)).toBe(true)
    expect(lifecycle.getPid()).toBe(activePid)
    expect(lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${primary}`)
    expect(await sessionAnswers(lifecycle.getInternalUrl())).toBe(true)

    // Lifecycle and native features must retain the same method owner. These
    // operations call sibling lifecycle methods through `this` internally.
    await harness.lifecycle.restart()
    expect(await waitForOpencodeReady(lifecycle, workspace)).toBe(true)
    expect(lifecycle.getPid()).not.toBe(activePid)
    expect(harness.lifecycle.getState()).toBe('ok')
    expect(await sessionAnswers(lifecycle.getInternalUrl())).toBe(true)
  }, 30_000)

  test('a candidate that never serves the session API is declined early and changes nothing', async () => {
    const r = rig()
    const livePid = await startReady(r)
    // Up for 1.5 s, answering /session 503, then gone: the verdict must come
    // from the session API, and a dead candidate must not wait out 90 s.
    setCtl(`mode-${r.standby}`, '503-then-exit')
    const spawnedBefore = r.spawned()

    const started = Date.now()
    const result = await r.lifecycle.reloadVerified()

    expect(result.outcome).toBe('kept-old')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(r.lifecycle.getPid()).toBe(livePid)
    expect(r.lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${r.primary}`)
    expect(r.lifecycle.getState()).toBe('ok')
    await Bun.sleep(1_000)
    // The dead candidate was unsupervised: its exit is a verdict, not an outage.
    expect(r.spawned()).toBe(spawnedBefore + 1)
    expect(r.lifecycle.getPid()).toBe(livePid)
    expect(r.lifecycle.getState()).toBe('ok')
  }, 30_000)

  test('a candidate half that already answers is declined, never "proven" by the incumbent', async () => {
    const r = rig()
    const livePid = await startReady(r)

    // Something else is already serving the session API on the idle half —
    // the shape a drifted port pair produces (`opencode serve --port <busy>`
    // exits at once with ServeError, so a candidate there is dead on arrival).
    const squatter = Bun.serve({ port: r.standby, hostname: '127.0.0.1', fetch: () => Response.json([]) })
    try {
      const result = await r.lifecycle.reloadVerified()
      expect(result.outcome).toBe('kept-old')
      if (result.outcome !== 'kept-old') throw new Error('unreachable')
      expect(result.reason).toContain('already answers')
      expect(r.lifecycle.getPid()).toBe(livePid)
      expect(processExists(livePid)).toBe(true)
      expect(r.lifecycle.getActivePort()).toBe(r.primary)
    } finally {
      squatter.stop(true)
    }
  }, 30_000)

  test('new requests route to the promoted process before the previous one retires', async () => {
    setCtl('slow-term')
    const r = rig()
    const oldPid = await startReady(r)

    const reload = r.lifecycle.reloadVerified()
    // The incumbent takes ~1 s to exit after SIGTERM. Routing must already
    // name the standby half while it is still alive.
    await waitFor(() => r.lifecycle.getInternalUrl() === `http://127.0.0.1:${r.standby}`, 10_000)
    expect(processExists(oldPid)).toBe(true)
    const result = await reload
    expect(result.outcome).toBe('swapped')
    expect(processExists(oldPid)).toBe(false)
  }, 30_000)

  test('the promoted process is supervised: a crash after promotion respawns', async () => {
    const r = rig()
    await startReady(r)
    const result = await r.lifecycle.reloadVerified()
    expect(result.outcome).toBe('swapped')
    if (result.outcome !== 'swapped') throw new Error(result.reason)

    process.kill(result.pid as number, 'SIGKILL')
    await waitFor(() => {
      const pid = r.lifecycle.getPid()
      return pid !== null && pid !== result.pid
    })
    await waitFor(() => sessionAnswers(r.lifecycle.getInternalUrl()))
  }, 30_000)

  test('reconfigure() with a foreign port pair cannot move the daemon off the port its child serves', async () => {
    // SampleCo 2026-08-25: the daemon reported `starting` + `opencode_port: 4096`
    // for two hours while its own child served on 4097. `activePort` had
    // drifted from the process. Now every reader asks the process.
    const r = rig()
    await startReady(r)

    const swapped = await r.lifecycle.reloadVerified()
    expect(swapped.outcome).toBe('swapped')
    expect(r.lifecycle.getActivePort()).toBe(r.standby)

    // The only code path that rewrites the port variable without touching the
    // process: a config whose pair does not contain the live port.
    r.lifecycle.reconfigure({ ...r.cfg, opencodeStandbyPort: reservePort() } as Config)

    expect(r.lifecycle.getActivePort()).toBe(r.standby)
    expect(r.lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${r.standby}`)
    expect(await sessionAnswers(r.lifecycle.getInternalUrl())).toBe(true)
    // reconfigure() marks `starting` until the next probe; the probe asks the
    // process's real port, so it comes back `ok` on its own.
    await waitFor(() => r.lifecycle.getState() === 'ok', 5_000)
  }, 20_000)

  test('stop and reload retire the whole process group, grandchildren included', async () => {
    // OpenCode forks its own `bun install` for the config dir. A grandchild
    // that outlives the kill races the next process's install into the same
    // node_modules.
    setCtl('fork-grandchild')
    const r = rig()
    const firstPid = await startReady(r)
    await waitFor(() => existsSync(join(ctl, `grandchild-${firstPid}`)))
    const retiredGrandchild = grandchildOf(firstPid)
    expect(processExists(retiredGrandchild)).toBe(true)

    const result = await r.lifecycle.reloadVerified()
    expect(result.outcome).toBe('swapped')
    if (result.outcome !== 'swapped') throw new Error(result.reason)
    await waitFor(() => !processExists(retiredGrandchild), 10_000)

    const liveGrandchild = grandchildOf(result.pid as number)
    expect(processExists(liveGrandchild)).toBe(true)
    await r.lifecycle.stop()
    await waitFor(() => !processExists(liveGrandchild), 10_000)
  }, 30_000)
})

// ── config reload ────────────────────────────────────────────────────────────

describe('reloadConfig', () => {
  test('a confirmed dispose re-reads the config in place, composed like a spawn', async () => {
    setCtl('dispose', 'json-true')
    // OPENCODE_CONFIG_DIR is the boot link: point it at a real config dir.
    const configDir = join(root, 'config')
    mkdirSync(join(configDir, 'skills'), { recursive: true })
    await serveTestConfigDir(configDir, join(root, 'boot-store'))
    const projectEnv = createProjectEnvStore({})
    const r = rig({ projectEnv })
    const pid = await startReady(r)
    // The dispose path must compose from the SAME env a spawn uses: a project
    // env value pushed after spawn reaches the file OpenCode re-reads.
    projectEnv.apply({ revision: 'r2', env: { OPENCODE_CONFIG_CONTENT: '{"theme":"reload-probe"}' } })

    const result = await r.lifecycle.reloadConfig()

    expect(result).toEqual({ how: 'disposed', turnEnded: false })
    expect(r.lifecycle.getPid()).toBe(pid)
    const config = JSON.parse(readFileSync(join(ctl, 'config-at-dispose.json'), 'utf8'))
    expect(config.theme).toBe('reload-probe')
    // The config dir is the boot link, so a release swap repoints the link and
    // the injected-skills path keeps resolving.
    expect(config.skills.paths).toContain(join(bootLinkPath(), 'skills'))
  }, 30_000)

  test.each([
    ['a 200 text/html answer (the SPA catch-all)', 'html'],
    ['a JSON false', 'json-false'],
    ['no dispose endpoint', ''],
  ])('%s is not a reload: it falls back to a verified swap', async (_name, dispose) => {
    if (dispose) setCtl('dispose', dispose)
    const r = rig()
    const pid = await startReady(r)

    const result = await r.lifecycle.reloadConfig()

    expect(result.how).toBe('restarted')
    expect(r.lifecycle.getPid()).not.toBe(pid)
    expect(r.lifecycle.getActivePort()).toBe(r.standby)
    expect(requestLog(r.primary).some((line) => line.includes('POST /global/dispose'))).toBe(true)
  }, 30_000)

  test('mustRespawn skips dispose entirely and swaps', async () => {
    setCtl('dispose', 'json-true')
    const r = rig()
    const pid = await startReady(r)

    const result = await r.lifecycle.reloadConfig({ mustRespawn: true })

    expect(result.how).toBe('restarted')
    expect(r.lifecycle.getPid()).not.toBe(pid)
    expect(requestLog(r.primary).some((line) => line.includes('/global/dispose'))).toBe(false)
  }, 30_000)

  test('without dispose, a config that cannot boot keeps the running OpenCode', async () => {
    const r = rig()
    const pid = await startReady(r)
    setCtl(`mode-${r.standby}`, 'exit')

    const result = await r.lifecycle.reloadConfig()

    expect(result).toEqual({ how: 'kept-old', turnEnded: false })
    expect(r.lifecycle.getPid()).toBe(pid)
    expect(r.lifecycle.getState()).toBe('ok')
  }, 30_000)
})

// ── unplanned-respawn hook (orphaned-turn finalize) ──────────────────────────

describe('onUnplannedRespawn', () => {
  function hookRig(hook: () => void | Promise<boolean | void> = () => {}) {
    const calls: Array<{ servedWhenCalled: Promise<boolean> }> = []
    let r!: Rig
    r = rig({
      onUnplannedRespawn: () => {
        calls.push({ servedWhenCalled: sessionAnswers(r.lifecycle.getInternalUrl()) })
        return hook()
      },
    })
    return { r, calls }
  }

  test('a crash respawns and runs the hook once, after the new process serves', async () => {
    const { r, calls } = hookRig()
    const pid = await startReady(r)

    process.kill(pid, 'SIGKILL')
    await waitFor(() => calls.length === 1)
    expect(await calls[0]!.servedWhenCalled).toBe(true)
    await Bun.sleep(500)
    expect(calls).toHaveLength(1)
  }, 30_000)

  test('a planned restart runs the hook once, after readiness', async () => {
    const { r, calls } = hookRig()
    await startReady(r)

    await r.lifecycle.restart()

    expect(calls).toHaveLength(1)
    expect(await calls[0]!.servedWhenCalled).toBe(true)
  }, 30_000)

  test('a boot-time restart that asks not to finalize returns without waiting for readiness', async () => {
    // The boot fallback chain restarts OpenCode on configs that may never
    // become ready, before any turn exists. Waiting the 60 s finalize budget
    // there only delays the next fallback step.
    const { r, calls } = hookRig()
    await startReady(r)
    setCtl('session-503')

    const started = Date.now()
    await r.lifecycle.restart({ finalizeTurn: false })

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await sessionAnswers(r.lifecycle.getInternalUrl())).toBe(false)
    expect(calls).toHaveLength(0)
  }, 30_000)

  test('a throwing hook cannot break the restart', async () => {
    const { r, calls } = hookRig(() => {
      throw new Error('finalize exploded')
    })
    await startReady(r)

    await r.lifecycle.restart()

    expect(calls).toHaveLength(1)
    expect(r.lifecycle.getState()).toBe('ok')
  }, 30_000)

  test('a planned stop neither respawns nor runs the hook', async () => {
    const { r, calls } = hookRig()
    await startReady(r)
    const spawnedBefore = r.spawned()

    await r.lifecycle.stop()
    await Bun.sleep(1_200)

    expect(r.spawned()).toBe(spawnedBefore)
    expect(r.lifecycle.getPid()).toBeNull()
    expect(calls).toHaveLength(0)
  }, 30_000)
})
