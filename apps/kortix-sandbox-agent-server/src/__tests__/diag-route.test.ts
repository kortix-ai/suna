/**
 * GET /kortix/diag — one call, the whole error report.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '@/lib/config/config'
import { __flushDaemonLogFileForTests, __resetLoggerFileSinkForTests, enableDaemonLogFile, logger } from '@/lib/log/logger'
import { startResourceMonitor } from '@/services/resources/resources'
import { createDiagRouter } from '@/routes/kortix/diag'
import { createPiConfigReleases } from '@/harness/pi/config-release'
import { createPiDiagnosticsService } from '@/harness/pi/diagnostics'
import type { HarnessDiagnosticsContext, HarnessDiagnosticsService } from '@/harness/contract/diagnostics'

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

describe('GET /kortix/diag', () => {
  const token = 'sandbox-token'
  const cfg = {
    sandboxToken: token,
    workspace: '/workspace',
    servicePort: 8000,
  } as Config

  test('returns state, resources, runtime report, and the daemon log tail in one document', async () => {
    enableDaemonLogFile()
    logger.info('[test] diag-line')
    await __flushDaemonLogFileForTests()
    const monitor = startResourceMonitor({ intervalMs: 60_000, runtimePid: () => 4242 })
    try {
      const app = createDiagRouter({
        cfg,
        staticWebPort: null,
        bootTime: Date.now() - 5_000,
        bootState: { repoMaterializationError: null, timeline: [{ label: 'proxy-up', atMs: 12 }] },
        resources: () => monitor,
      }, createPiDiagnosticsService(() => null, () => null, createPiConfigReleases({ cfg, env: {} })))
      const res = await app.request('http://d/?tail=50', { headers: { Authorization: `Bearer ${token}` } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, any>
      // The production pi report over a runtime that never started.
      expect(body.pi).toMatchObject({ state: 'down', root_id: null, start_error: null })
      expect(body.daemon.uptime_s).toBeGreaterThanOrEqual(5)
      expect(body.daemon.daemon_log_file).toBe(join(root, 'daemon.log'))
      expect(body.boot.timeline).toEqual([{ label: 'proxy-up', atMs: 12 }])
      expect(body.resources).not.toBeNull()
      expect(Array.isArray(body.resources.disks)).toBe(true)
      expect(body.resources_previous).not.toBeNull()
      expect(body.logs.tail).toBe(50)
      expect(String(body.logs.daemon)).toContain('[test] diag-line')
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
