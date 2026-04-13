import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import { cleanupRuntimeFixture, createRuntimeFixture, startDummyOpenCode, waitForHttp, type RuntimeFixture } from './helpers'

const MASTER_PORT = 18000
const OPENCODE_TEST_PORT = 19000
const TEST_WS_PORT = 17788
const BASE_WS_URL = `ws://127.0.0.1:${MASTER_PORT}`

interface StartedServer {
  process: ChildProcess
  stop: () => Promise<void>
}

let runtime: RuntimeFixture
let master: StartedServer | null = null
let opencode: Awaited<ReturnType<typeof startDummyOpenCode>> | null = null
let upstreamWsServer: Bun.Server | null = null
let lastUpstreamOrigin: string | null = null

async function startKortixMasterForTest(
  port: number,
  fixture: RuntimeFixture,
  extraEnv: Record<string, string> = {},
): Promise<StartedServer> {
  const proc = spawn('bun', ['run', 'src/index.ts'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SECRET_FILE_PATH: fixture.secretFilePath,
      SALT_FILE_PATH: fixture.saltFilePath,
      AUTH_JSON_PATH: fixture.authJsonPath,
      BOOTSTRAP_PATH: fixture.bootstrapPath,
      KORTIX_WORKSPACE_ROOT: fixture.workspaceRoot,
      S6_ENV_DIR: fixture.s6EnvDir,
      KORTIX_MASTER_PORT: String(port),
      OPENCODE_HOST: '127.0.0.1',
      OPENCODE_PORT: String(port + 1000),
      KORTIX_DISABLE_CORE_SUPERVISOR: 'true',
      KORTIX_DISABLE_AUTH_SYNC: 'true',
      ...extraEnv,
    },
  })

  proc.stderr?.on('data', (chunk) => {
    const text = chunk.toString().trim()
    if (text) console.error('Server error:', text)
  })

  await waitForHttp(`http://127.0.0.1:${port}/docs`)

  return {
    process: proc,
    stop: async () => {
      if (!proc.killed) proc.kill()
      await new Promise((resolve) => setTimeout(resolve, 300))
    },
  }
}

async function startUpstreamWsServer(): Promise<void> {
  upstreamWsServer = Bun.serve({
    port: TEST_WS_PORT,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        return Response.json({ ok: true })
      }

      lastUpstreamOrigin = req.headers.get('origin')
      const success = server.upgrade(req, { data: {} })
      return success ? undefined : new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      open(ws) {
        ws.send('connected')
      },
      message(ws, message) {
        ws.send(`echo:${String(message)}`)
      },
    },
  })

  await waitForHttp(`http://127.0.0.1:${TEST_WS_PORT}/health`)
}

async function stopUpstreamWsServer(): Promise<void> {
  if (upstreamWsServer) {
    await upstreamWsServer.stop(true)
    upstreamWsServer = null
  }
}

function waitForEvent<T>(
  ws: WebSocket,
  type: 'open' | 'message' | 'close' | 'error',
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for WebSocket ${type}`))
    }, timeoutMs)

    const onOpen = (event: Event) => {
      if (type !== 'open') return
      cleanup()
      resolve(event as T)
    }
    const onMessage = (event: MessageEvent) => {
      if (type !== 'message') return
      cleanup()
      resolve(event as T)
    }
    const onClose = (event: CloseEvent) => {
      if (type !== 'close') return
      cleanup()
      resolve(event as T)
    }
    const onError = (event: Event) => {
      if (type === 'error') {
        cleanup()
        resolve(event as T)
        return
      }
      cleanup()
      reject(new Error(`Unexpected WebSocket error while waiting for ${type}`))
    }

    function cleanup() {
      clearTimeout(timer)
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }

    ws.addEventListener('open', onOpen)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
  })
}

describe('Kortix Sandbox Proxy WebSocket E2E', () => {
  beforeAll(async () => {
    runtime = createRuntimeFixture('kortix-proxy-ws-')
    opencode = await startDummyOpenCode(OPENCODE_TEST_PORT)
    master = await startKortixMasterForTest(MASTER_PORT, runtime, {
      KORTIX_TOKEN: 'proxy-test-token',
      OPENCODE_PORT: String(OPENCODE_TEST_PORT),
    })
    await startUpstreamWsServer()
  }, 30_000)

  afterAll(async () => {
    await stopUpstreamWsServer()
    await master?.stop()
    await opencode?.stop()
    await cleanupRuntimeFixture(runtime)
  })

  test('proxies websocket traffic to an upstream localhost service', async () => {
    const ws = new WebSocket(`${BASE_WS_URL}/proxy/${TEST_WS_PORT}/`, {
      headers: {
        Origin: 'http://preview.test',
      },
    } as any)

    await waitForEvent<Event>(ws, 'open')

    const connected = await waitForEvent<MessageEvent>(ws, 'message')
    expect(String(connected.data)).toBe('connected')

    ws.send('ping')
    const echoed = await waitForEvent<MessageEvent>(ws, 'message')
    expect(String(echoed.data)).toBe('echo:ping')
    expect(lastUpstreamOrigin).toBe('http://preview.test')

    ws.close()
    await waitForEvent<CloseEvent>(ws, 'close')
  }, 15_000)
})
