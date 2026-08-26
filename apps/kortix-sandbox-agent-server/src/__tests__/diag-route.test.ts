/**
 * GET /kortix/diag — one call, the whole error report.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config'
import { __flushDaemonLogFileForTests, __resetLoggerFileSinkForTests, enableDaemonLogFile, logger } from '../logger'
import type { Opencode } from '../opencode'
import { startResourceMonitor } from '../resources'
import { createDiagRouter } from '../routes/diag'

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
  } as Config

  test('401 without credentials', async () => {
    const app = createDiagRouter(cfg, {
      opencode: fakeOpencode,
      bootTime: Date.now(),
      bootState: { repoMaterializationError: null, timeline: [] },
      opencodeHome: root,
      resources: () => null,
    })
    expect((await app.request('http://d/')).status).toBe(401)
  })

  test('returns state, resources, runtime report, and both log tails in one document', async () => {
    enableDaemonLogFile()
    logger.info('[test] diag-line')
    await __flushDaemonLogFileForTests()
    mkdirSync(join(root, '.local', 'share', 'opencode', 'log'), { recursive: true })
    writeFileSync(join(root, '.local', 'share', 'opencode', 'log', 'opencode.log'), 'oc-line\n')
    const monitor = startResourceMonitor({ intervalMs: 60_000, opencodePid: () => 4242 })
    try {
      const app = createDiagRouter(cfg, {
        opencode: fakeOpencode,
        bootTime: Date.now() - 5_000,
        bootState: { repoMaterializationError: null, timeline: [{ label: 'proxy-up', atMs: 12 }] },
        opencodeHome: root,
        resources: () => monitor,
      })
      const res = await app.request('http://d/?tail=50', { headers: { Authorization: `Bearer ${token}` } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, any>
      expect(body.opencode).toMatchObject({ state: 'ok', pid: 4242, port: 4097, port_pair: [4096, 4097] })
      expect(body.daemon.uptime_s).toBeGreaterThanOrEqual(5)
      expect(body.daemon.daemon_log_file).toBe(join(root, 'daemon.log'))
      expect(body.boot.timeline).toEqual([{ label: 'proxy-up', atMs: 12 }])
      expect(body.resources).not.toBeNull()
      expect(Array.isArray(body.resources.disks)).toBe(true)
      expect(body.logs.tail).toBe(50)
      expect(String(body.logs.daemon)).toContain('[test] diag-line')
      expect(body.logs.opencode).toBe('oc-line\n')
      // Never a secret dump.
      expect(JSON.stringify(body)).not.toContain(token)
    } finally {
      monitor.stop()
    }
  })
})
