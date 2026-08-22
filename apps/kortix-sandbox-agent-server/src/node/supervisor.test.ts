import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { promoteStagedKortixd, rollbackKortixd, superviseKortixd } from './supervisor'

function stage(directory: string, bytes: string, digest = createHash('sha256').update(bytes).digest('hex')) {
  writeFileSync(join(directory, 'agent.next'), bytes)
  writeFileSync(join(directory, 'agent.next.sha256'), `${digest}\n`)
}

function childExit(code: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { exitCode: null, kill: () => true })
  queueMicrotask(() => child.emit('exit', code, null))
  return child
}

describe('kortixd native supervisor', () => {
  test('promotes only independently verified staged bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-supervisor-'))
    try {
      stage(directory, 'bad', '0'.repeat(64))
      expect(promoteStagedKortixd(directory)).toBe(false)
      expect(existsSync(join(directory, 'agent.current'))).toBe(false)
      stage(directory, 'good')
      expect(promoteStagedKortixd(directory)).toBe(true)
      expect(readFileSync(join(directory, 'agent.current'), 'utf8')).toBe('good')
      if (process.platform !== 'win32') expect(Bun.spawnSync(['test', '-x', join(directory, 'agent.current')]).exitCode).toBe(0)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test('rolls back to the prior binary and pins further updates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-supervisor-'))
    try {
      writeFileSync(join(directory, 'agent.current'), 'new')
      writeFileSync(join(directory, 'agent.prev'), 'old')
      expect(rollbackKortixd(directory)).toBe(true)
      expect(readFileSync(join(directory, 'agent.current'), 'utf8')).toBe('old')
      expect(existsSync(join(directory, 'agent.pinned'))).toBe(true)
      stage(directory, 'newer')
      expect(promoteStagedKortixd(directory)).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test('retries a requested swap and rolls back two early crashes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-supervisor-'))
    const launches: string[] = []
    try {
      writeFileSync(join(directory, 'agent.current'), 'known')
      chmodSync(join(directory, 'agent.current'), 0o755)
      stage(directory, 'candidate')
      let call = 0
      const code = await superviseKortixd({
        stateDirectory: directory,
        bakedExecutable: '/baked/kortixd',
        healthyAfterMs: 60_000,
        maxEarlyExits: 2,
        now: () => call * 10,
        spawnProcess: (executable) => { launches.push(executable); return childExit([75, 1, 1, 0][call++] ?? 0) },
      })
      expect(code).toBe(0)
      expect(launches).toHaveLength(4)
      expect(readFileSync(join(directory, 'agent.current'), 'utf8')).toBe('known')
      expect(existsSync(join(directory, 'agent.pinned'))).toBe(true)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
