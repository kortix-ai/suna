import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config'
import { createOpencodeSupervisor } from '../opencode'

// OpenCode 1.18 binds its port ~100 ms before its request handler exists
// (Effect NodeHttpServer: listen() in `make`, on("request") in `serve`). A
// request accepted in that window is never answered. It prints
// `opencode server listening on http://…` only after the handler is attached.
// The fake binary below models both: a raw TCP listener that holds every
// connection accepted in its first `deadMs` (and counts them in HELD_FILE),
// serves plain HTTP afterwards, and — when `announce` — prints the line once
// the window has closed.

let root: string
let supervisor: ReturnType<typeof createOpencodeSupervisor> | null

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const port = server.port
  server.stop(true)
  if (typeof port !== 'number') throw new Error('Bun did not assign a port')
  return port
}

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-listening-line-'))
  supervisor = null
})

afterEach(async () => {
  await supervisor?.stop()
  rmSync(root, { recursive: true, force: true })
})

function makeCfg(): Config {
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  return {
    workspace,
    projectTarget: workspace,
    opencodeInternalPort: reservePort(),
    opencodeStandbyPort: reservePort(),
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
  } as Config
}

describe('OpenCode supervisor listening announcement', () => {
  test('nothing is sent before the announcement; the first probe lands after the window', async () => {
    const configDir = join(root, 'config')
    const binary = join(root, 'opencode')
    const heldFile = join(root, 'held.log')
    mkdirSync(configDir)
    // 400 ms window: the 100 ms poll would land in it several times.
    writeDeadWindowBinary(binary, 400, true, heldFile)

    const marks: string[] = []
    let forwarded = ''
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      forwarded += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write
    try {
      supervisor = createOpencodeSupervisor(makeCfg(), configDir, undefined, {
        binaryPathOverride: binary,
        configPathOverride: join(root, 'runtime-config.json'),
        onStartupMark: (label) => marks.push(label),
      })

      const started = Date.now()
      await supervisor.start()
      await supervisor.waitForCurrentListening()
      const listeningAfterMs = Date.now() - started
      await supervisor.waitForCurrentReadyResponse()
      const readyAfterMs = Date.now() - started

      // Not one connection reached the port while the handler was missing.
      expect(heldCount(heldFile)).toBe(0)
      // The announcement comes after the window closes: bun startup + 400 ms.
      expect(listeningAfterMs).toBeGreaterThanOrEqual(400)
      // …and readiness follows within one poll interval plus one probe.
      expect(readyAfterMs).toBeLessThan(listeningAfterMs + 1_000)
      expect(marks.filter((m) => m === 'opencode-listening-line')).toHaveLength(1)
      expect(forwarded).toContain('opencode server listening on http://127.0.0.1:')
    } finally {
      process.stdout.write = originalWrite as typeof process.stdout.write
    }
  }, 15_000)

  test('without the announcement the fallback probe still finds the process', async () => {
    const configDir = join(root, 'config')
    const binary = join(root, 'opencode')
    const heldFile = join(root, 'held.log')
    mkdirSync(configDir)
    writeDeadWindowBinary(binary, 300, false, heldFile)

    supervisor = createOpencodeSupervisor(makeCfg(), configDir, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
      // The real value is 10 s; the point here is only that probing resumes.
      listeningLineFallbackMs: 200,
    })

    const started = Date.now()
    await supervisor.start()
    await supervisor.waitForCurrentReadyResponse()
    const readyAfterMs = Date.now() - started

    // The fallback pays for the window (a probe dropped in it waits its 2 s
    // timeout), but the process is found and the listening waiter resolves.
    expect(readyAfterMs).toBeLessThan(6_000)
    await supervisor.waitForCurrentListening()
  }, 15_000)
})
