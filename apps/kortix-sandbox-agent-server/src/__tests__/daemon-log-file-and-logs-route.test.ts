/**
 * The daemon log lands on disk and is readable through GET /kortix/logs —
 * and the sink can never hurt the box.
 *
 * 2026-08-25: two hours of an SampleCo daemon reporting `starting` on the wrong
 * port could be fenced but not proven, because its stdout lived on a stream
 * nobody kept (E2B envd). Every line now also lands in a file on the box.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config'
import type { Opencode } from '../harness/open-code/lifecycle'
import type { HarnessDiagnosticsService } from '../harness/diagnostics'
import {
  DAEMON_LOG_BUFFER_CAP_BYTES,
  DAEMON_LOG_MAX_LINE_BYTES,
  __daemonLogSinkStateForTests,
  __flushDaemonLogFileForTests,
  __resetLoggerFileSinkForTests,
  daemonLogFilePath,
  enableDaemonLogFile,
  logger,
} from '../logger'
import { createLogsRouter } from '../routes/logs'
import { createOpenCodeDiagnosticsService } from '../harness/open-code/diagnostics'

let root: string
const savedEnv = { file: process.env.KORTIX_DAEMON_LOG_FILE, max: process.env.KORTIX_DAEMON_LOG_MAX_BYTES }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-daemon-log-'))
  process.env.KORTIX_DAEMON_LOG_FILE = join(root, 'logs', 'agent.log')
  delete process.env.KORTIX_DAEMON_LOG_MAX_BYTES
  __resetLoggerFileSinkForTests()
})

afterEach(async () => {
  // Drain before the tmp dir goes away: a flush in flight must not outlive its dir.
  await __flushDaemonLogFileForTests()
  if (savedEnv.file === undefined) delete process.env.KORTIX_DAEMON_LOG_FILE
  else process.env.KORTIX_DAEMON_LOG_FILE = savedEnv.file
  if (savedEnv.max === undefined) delete process.env.KORTIX_DAEMON_LOG_MAX_BYTES
  else process.env.KORTIX_DAEMON_LOG_MAX_BYTES = savedEnv.max
  __resetLoggerFileSinkForTests()
  rmSync(root, { recursive: true, force: true })
})

async function readLines(path: string): Promise<Array<Record<string, unknown>>> {
  await __flushDaemonLogFileForTests()
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('daemon log file sink', () => {
  test('off until enabled: importing the logger never touches the disk', () => {
    logger.info('[test] before enable')
    expect(existsSync(join(root, 'logs'))).toBe(false)
  })

  test('every level lands as one JSON line, directory created on demand', async () => {
    expect(enableDaemonLogFile().path).toBe(join(root, 'logs', 'agent.log'))
    logger.info('[test] hello', { a: 1 })
    logger.error('[test] boom', new Error('kaput'))
    const lines = await readLines(daemonLogFilePath() as string)
    expect(lines.map((l) => l.msg)).toEqual(['[test] hello', '[test] boom'])
    expect(lines[0]?.a).toBe(1)
    expect((lines[1]?.error as { message: string }).message).toBe('kaput')
  })

  test('a single oversized line is truncated, never written whole', async () => {
    enableDaemonLogFile()
    logger.info('[test] big', { blob: 'x'.repeat(DAEMON_LOG_MAX_LINE_BYTES * 3) })
    await __flushDaemonLogFileForTests()
    const text = readFileSync(daemonLogFilePath() as string, 'utf8')
    expect(text.length).toBeLessThanOrEqual(DAEMON_LOG_MAX_LINE_BYTES + 1)
    expect(text).toContain('[truncated]')
  })

  test('memory is bounded: oldest lines are dropped and the drop is recorded', async () => {
    enableDaemonLogFile()
    // Do not flush between lines: everything below queues behind the cap.
    const line = 'y'.repeat(60 * 1024)
    for (let i = 0; i < 40; i++) logger.info(`[test] ${i}`, { line })
    const state = __daemonLogSinkStateForTests()
    expect(state.pendingBytes).toBeLessThanOrEqual(DAEMON_LOG_BUFFER_CAP_BYTES)
    expect(state.dropped).toBeGreaterThan(0)
    const lines = await readLines(daemonLogFilePath() as string)
    expect(lines.some((l) => String(l.msg).startsWith('[logger] dropped'))).toBe(true)
  })

  test('rotates to <file>.1 past KORTIX_DAEMON_LOG_MAX_BYTES', async () => {
    process.env.KORTIX_DAEMON_LOG_MAX_BYTES = '100000'
    enableDaemonLogFile()
    const path = daemonLogFilePath() as string
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 400; i++) logger.info(`[test] ${round}/${i} ${'x'.repeat(80)}`)
      await __flushDaemonLogFileForTests()
    }
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(statSync(path).size).toBeLessThan(2 * 100000 + 64 * 1024)
  })

  test('an unwritable path disables the sink for good and stdout keeps flowing', async () => {
    writeFileSync(join(root, 'not-a-dir'), 'file')
    process.env.KORTIX_DAEMON_LOG_FILE = join(root, 'not-a-dir', 'agent.log')
    __resetLoggerFileSinkForTests()
    enableDaemonLogFile()
    logger.info('[test] one')
    await __flushDaemonLogFileForTests()
    expect(__daemonLogSinkStateForTests().disabled).toBe(true)
    // Still no throw, still no growth.
    logger.info('[test] two')
    expect(__daemonLogSinkStateForTests().pendingBytes).toBe(0)
  })

  test('KORTIX_DAEMON_LOG_FILE=off keeps the sink off even when enabled', () => {
    process.env.KORTIX_DAEMON_LOG_FILE = 'off'
    __resetLoggerFileSinkForTests()
    expect(enableDaemonLogFile().path).toBeNull()
    logger.info('[test] nothing on disk')
    expect(existsSync(join(root, 'logs'))).toBe(false)
  })

  test('a ctx that cannot be serialized does not lose the line', async () => {
    enableDaemonLogFile()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    logger.warn('[test] cyclic', cyclic)
    const lines = await readLines(daemonLogFilePath() as string)
    expect(lines[0]?.msg).toBe('[test] cyclic')
    expect(lines[0]?.ctx).toBe('[unserializable]')
  })
})

describe('GET /kortix/logs', () => {
  const token = 'sandbox-token'
  const cfg = { sandboxToken: token } as Config

  test('tails the daemon log for the service caller, and both sources on demand', async () => {
    enableDaemonLogFile()
    logger.info('[test] first')
    logger.info('[test] second')
    await __flushDaemonLogFileForTests()
    mkdirSync(join(root, '.local', 'share', 'opencode', 'log'), { recursive: true })
    writeFileSync(join(root, '.local', 'share', 'opencode', 'log', 'opencode.log'), 'oc-1\noc-2\n')
    const app = createLogsRouter(cfg, createOpenCodeDiagnosticsService({} as Opencode, root))

    const agent = await app.request('http://d/?tail=1', { headers: { Authorization: `Bearer ${token}` } })
    expect(agent.status).toBe(200)
    expect(agent.headers.get('content-type')).toContain('text/plain')
    const agentText = await agent.text()
    expect(agentText).toContain('[test] second')
    expect(agentText).not.toContain('[test] first')

    const all = await app.request('http://d/?source=all&tail=5', { headers: { Authorization: `Bearer ${token}` } })
    expect(all.status).toBe(200)
    const allText = await all.text()
    expect(allText).toContain('==> ')
    expect(allText).toContain('oc-2')
    expect(allText).toContain('[test] first')

    const bad = await app.request('http://d/?source=nope', { headers: { Authorization: `Bearer ${token}` } })
    expect(bad.status).toBe(400)
  })

  test('404 when no requested source exists on disk', async () => {
    const app = createLogsRouter(cfg, createOpenCodeDiagnosticsService({} as Opencode, root))
    const res = await app.request('http://d/?source=opencode', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(404)
  })

  test('the controller uses the selected service log sources and owns tail parsing and response headers', async () => {
    const reads: Array<{ source: string; lines: number }> = []
    const diagnostics = {
      logSources: () => ['daemon', 'other-runtime'],
      readLog(source: string, lines: number) {
        reads.push({ source, lines })
        return { label: `/logs/${source}`, text: `${source} output\n` }
      },
    } as unknown as HarnessDiagnosticsService
    const app = createLogsRouter(cfg, diagnostics)
    const headers = { Authorization: `Bearer ${token}` }
    const denied = await app.request('/?source=all')
    expect(denied.status).toBe(401)
    expect(reads).toEqual([])

    const all = await app.request('/?source=ALL&tail=9000', { headers })
    expect(all.status).toBe(200)
    expect(all.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(all.headers.get('cache-control')).toBe('no-store')
    expect(all.headers.get('x-kortix-log-tail')).toBe('5000')
    expect(await all.text()).toBe('==> /logs/daemon <==\ndaemon output\n==> /logs/other-runtime <==\nother-runtime output\n')
    expect(reads).toEqual([{ source: 'daemon', lines: 5000 }, { source: 'other-runtime', lines: 5000 }])

    const unsupported = await app.request('/?source=opencode', { headers })
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toEqual({ error: 'unknown source', detail: 'source must be daemon, other-runtime, or all' })
    expect(reads).toHaveLength(2)
  })

})
