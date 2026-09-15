import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config'
import { createOpencodeSupervisor } from '../opencode'

// OpenCode 1.18 binds its port ~100 ms before its request handler exists
// (Effect NodeHttpServer: listen() in `make`, on("request") in `serve`). A
// request accepted in that window is never answered. The fake binary below
// models it with a raw TCP listener that holds every connection accepted in
// its first `deadMs` and serves plain HTTP afterwards.

let root: string
let supervisor: ReturnType<typeof createOpencodeSupervisor> | null

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const port = server.port
  server.stop(true)
  if (typeof port !== 'number') throw new Error('Bun did not assign a port')
  return port
}

function writeDeadWindowBinary(path: string, deadMs: number) {
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
      if (Date.now() - bound < ${deadMs}) held.push(socket)
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
setInterval(() => {}, 60_000)
`,
  )
  chmodSync(path, 0o755)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-listening-response-'))
  supervisor = null
})

afterEach(async () => {
  await supervisor?.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('OpenCode supervisor first listening response', () => {
  test('a probe dropped in the bind→handler window costs the short timeout, not the 2 s directory probe', async () => {
    const workspace = join(root, 'workspace')
    const configDir = join(root, 'config')
    const binary = join(root, 'opencode')
    mkdirSync(workspace)
    mkdirSync(configDir)
    // 400 ms window: the 100 ms poll always lands in it once.
    writeDeadWindowBinary(binary, 400)

    const cfg = {
      workspace,
      projectTarget: workspace,
      opencodeInternalPort: reservePort(),
      opencodeStandbyPort: reservePort(),
      gitUserName: 'Kortix Agent',
      gitUserEmail: 'agent@kortix.ai',
    } as Config
    let listeningReports = 0
    let readyReports = 0
    supervisor = createOpencodeSupervisor(cfg, configDir, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
      onFirstListeningResponse: () => {
        listeningReports += 1
      },
      onFirstReadyResponse: () => {
        readyReports += 1
      },
    })

    const started = Date.now()
    await supervisor.start()
    await supervisor.waitForCurrentListeningResponse()
    const listeningAfterMs = Date.now() - started
    await supervisor.waitForCurrentReadyResponse()
    const readyAfterMs = Date.now() - started

    // bun startup (~0.3–0.6 s) + one dropped 300 ms liveness probe + one
    // answered one. The old 2 s directory probe put this past 2.5 s.
    expect(listeningAfterMs).toBeLessThan(2_000)
    expect(readyAfterMs).toBeLessThan(2_500)
    expect(readyAfterMs).toBeGreaterThanOrEqual(listeningAfterMs)
    expect(listeningReports).toBe(1)
    expect(readyReports).toBe(1)
  }, 15_000)
})
