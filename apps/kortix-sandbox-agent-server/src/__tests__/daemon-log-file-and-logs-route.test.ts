/**
 * The daemon log lands on disk and is readable through GET /kortix/logs —
 * and the sink can never hurt the box.
 *
 * 2026-08-25: two hours of an Essentia daemon reporting `starting` on the wrong
 * port could be fenced but not proven, because its stdout lived on a stream
 * nobody kept (E2B envd). Every line now also lands in a file on the box.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config'
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
import { createLogsRouter, tailFile } from '../routes/logs'

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

describe('tailFile', () => {
  test('returns the last N lines and null for a missing file', () => {
    const p = join(root, 't.log')
    writeFileSync(p, Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n') + '\n')
    expect(tailFile(p, 3)).toBe('l47\nl48\nl49\n')
    expect(tailFile(join(root, 'missing.log'), 3)).toBeNull()
  })
})

describe('GET /kortix/logs', () => {
  const token = 'sandbox-token'
  const cfg = { sandboxToken: token } as Config

  test('401 without the service bearer or a user context', async () => {
    const app = createLogsRouter(cfg, { opencodeHome: root })
    const res = await app.request('http://d/?tail=10')
    expect(res.status).toBe(401)
  })

  test('tails the daemon log for the service caller, and both sources on demand', async () => {
    enableDaemonLogFile()
    logger.info('[test] first')
    logger.info('[test] second')
    await __flushDaemonLogFileForTests()
    mkdirSync(join(root, '.local', 'share', 'opencode', 'log'), { recursive: true })
    writeFileSync(join(root, '.local', 'share', 'opencode', 'log', 'opencode.log'), 'oc-1\noc-2\n')
    const app = createLogsRouter(cfg, { opencodeHome: root })

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
    const app = createLogsRouter(cfg, { opencodeHome: root })
    const res = await app.request('http://d/?source=opencode', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(404)
  })
})
