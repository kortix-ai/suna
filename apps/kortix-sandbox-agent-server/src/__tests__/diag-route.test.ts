/**
 * GET /kortix/diag — one call, the whole error report.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { __flushDaemonLogFileForTests, __resetLoggerFileSinkForTests, enableDaemonLogFile, logger } from '../logger'
import type { Opencode } from '../harness/open-code/lifecycle'
import { startResourceMonitor } from '../resources'
import { createDiagRouter } from '../routes/diag'
import { createOpenCodeDiagnosticsService } from '../harness/open-code/diagnostics'
import type { HarnessDiagnosticsContext, HarnessDiagnosticsService } from '../harness/diagnostics'

let root: string
const savedEnv = process.env.KORTIX_DAEMON_LOG_FILE

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-diag-'))
  process.env.KORTIX_DAEMON_LOG_FILE = join(root, 'daemon.log')
  __resetLoggerFileSinkForTests()
})

afterEach(async () => {
  await __flushDaemonLogFileForTests()
  if (savedEnv === undefined) delete process.env.KORTIX_DAEMON_LOG_FILE
  else process.env.KORTIX_DAEMON_LOG_FILE = savedEnv
  __resetLoggerFileSinkForTests()
  rmSync(root, { recursive: true, force: true })
})

const fakeOpencode = {
  getState: () => 'ok',
  getPid: () => 4242,
  getActivePort: () => 4097,
  getInternalUrl: () => 'http://127.0.0.1:4097',
  getBinaryPath: () => '/opt/kortix/opencode.current',
} as unknown as Opencode

describe('GET /kortix/diag', () => {
  const token = 'sandbox-token'
  const cfg = {
    sandboxToken: token,
    workspace: '/workspace',
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    defaultOpencodeConfigDir: '/tmp/opencode',
  } as Config

  test('401 without credentials', async () => {
    const app = createDiagRouter({
      cfg,
      staticWebPort: null,
      bootTime: Date.now(),
      bootState: { repoMaterializationError: null, timeline: [] },
      resources: () => null,
    }, createOpenCodeDiagnosticsService(fakeOpencode, root))
    expect((await app.request('http://d/')).status).toBe(401)
  })

  test('returns state, resources, runtime report, and both log tails in one document', async () => {
    enableDaemonLogFile()
    logger.info('[test] diag-line')
    await __flushDaemonLogFileForTests()
    mkdirSync(join(root, '.local', 'share', 'opencode', 'log'), { recursive: true })
    writeFileSync(join(root, '.local', 'share', 'opencode', 'log', 'opencode.log'), 'oc-line\n')
    const monitor = startResourceMonitor({ intervalMs: 60_000, runtimePid: () => 4242 })
    try {
      const app = createDiagRouter({
        cfg,
        staticWebPort: null,
        bootTime: Date.now() - 5_000,
        bootState: { repoMaterializationError: null, timeline: [{ label: 'proxy-up', atMs: 12 }] },
        resources: () => monitor,
      }, createOpenCodeDiagnosticsService(fakeOpencode, root))
      const res = await app.request('http://d/?tail=50', { headers: { Authorization: `Bearer ${token}` } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, any>
      expect(body.opencode).toMatchObject({ state: 'ok', pid: 4242, port: 4097, port_pair: [4096, 4097] })
      expect(body.daemon.uptime_s).toBeGreaterThanOrEqual(5)
      expect(body.daemon.daemon_log_file).toBe(join(root, 'daemon.log'))
      expect(body.boot.timeline).toEqual([{ label: 'proxy-up', atMs: 12 }])
      expect(body.resources).not.toBeNull()
      expect(Array.isArray(body.resources.disks)).toBe(true)
      expect(body.resources.opencode.pid).toBe(4242)
      expect(Array.isArray(body.resources.opencodePids)).toBe(true)
      expect(body.resources).not.toHaveProperty('runtime')
      expect(body.resources).not.toHaveProperty('runtimePids')
      expect(body.resources_previous.opencode.pid).toBe(4242)
      expect(body.resources_previous).not.toHaveProperty('runtime')
      expect(body.resources_previous).not.toHaveProperty('runtimePids')
      expect(body.logs.tail).toBe(50)
      expect(String(body.logs.daemon)).toContain('[test] diag-line')
      expect(body.logs.opencode).toBe('oc-line\n')
      // Never a secret dump.
      expect(JSON.stringify(body)).not.toContain(token)
    } finally {
      monitor.stop()
    }
  })

  test('authentication and query validation precede the selected diagnostics operation', async () => {
    const tails: number[] = []
    const context: HarnessDiagnosticsContext = {
      cfg,
      staticWebPort: null,
      bootTime: Date.now(),
      bootState: { repoMaterializationError: null, timeline: [] },
      resources: () => null,
    }
    const diagnostics = {
      async report(received: HarnessDiagnosticsContext, tail: number) {
        expect(received).toBe(context)
        tails.push(tail)
        return { source: 'selected-runtime', tail }
      },
    } as unknown as HarnessDiagnosticsService
    const app = createDiagRouter(context, diagnostics)
    const noToken = createDiagRouter({ ...context, cfg: { ...cfg, sandboxToken: '' } }, diagnostics)
    expect((await noToken.request('/')).status).toBe(503)
    expect((await app.request('/')).status).toBe(401)
    expect(tails).toEqual([])

    const headers = { Authorization: `Bearer ${token}` }
    for (const [query, expected] of [['', 200], ['?tail=-1', 200], ['?tail=3000', 2000], ['?tail=2.9', 2]] as const) {
      const response = await app.request(`/${query}`, { headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ source: 'selected-runtime', tail: expected })
    }
    expect(tails).toEqual([200, 200, 2000, 2])
  })

})
