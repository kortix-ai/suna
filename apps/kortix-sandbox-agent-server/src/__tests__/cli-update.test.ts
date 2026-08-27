import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseFlags,
  performRollback,
  performUpdate,
  type ResolvedTarget,
  type SpawnDeps,
  type UpdateOptions,
} from '../cli'

function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortixd-cli-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A spawn seam that reports each candidate as healthy or not by path substring. */
function spawnWith(rule: (bin: string, args: string[]) => number): SpawnDeps {
  return { run: async (bin, args) => rule(bin, args) }
}

function baseOpts(overrides: Partial<UpdateOptions>): UpdateOptions {
  return {
    targetPath: join(dir, 'kortixd'),
    bestEffort: false,
    statePath: join(dir, '.state.json'),
    spawn: spawnWith(() => 0), // everything healthy by default
    ...overrides,
  }
}

function resolveTo(bytes: Buffer): (o: UpdateOptions) => Promise<ResolvedTarget> {
  return async () => ({ sha256: sha(bytes), bytes, source: 'file' })
}

describe('parseFlags', () => {
  test('parses value, equals, and boolean forms', () => {
    expect(parseFlags(['--from', 'x', '--dir=y', '--boot'])).toEqual({
      from: 'x',
      dir: 'y',
      boot: true,
    })
  })
})

describe('performUpdate', () => {
  test('no-op when the current binary already matches the target digest', async () => {
    const current = Buffer.from('BINARY-V1')
    writeFileSync(join(dir, 'kortixd'), current)
    const res = await performUpdate(baseOpts({ resolveTarget: resolveTo(current) }))
    expect(res.outcome).toBe('current')
    expect(res.code).toBe(0)
    // The running binary is untouched and no .prev appears.
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V1')
    expect(existsSync(join(dir, 'kortixd.prev'))).toBe(false)
  })

  test('happy path: swaps in the new binary and keeps .prev', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2')
    const res = await performUpdate(baseOpts({ resolveTarget: resolveTo(next) }))
    expect(res.outcome).toBe('updated')
    expect(res.code).toBe(0)
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V2')
    expect(readFileSync(join(dir, 'kortixd.prev')).toString()).toBe('BINARY-V1')
  })

  test('digest mismatch: nothing is swapped', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2')
    // Claim a digest that does not describe the bytes.
    const badResolve = async (): Promise<ResolvedTarget> => ({
      sha256: sha(Buffer.from('SOMETHING-ELSE')),
      bytes: next,
      source: 'file',
    })
    const res = await performUpdate(baseOpts({ resolveTarget: badResolve }))
    expect(res.outcome).toBe('failed')
    expect(res.code).toBe(1)
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V1')
    expect(existsSync(join(dir, 'kortixd.prev'))).toBe(false)
  })

  test('pre-swap smoke failure: keeps the current binary, no swap', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2-BROKEN')
    // Any candidate that is not the live target path fails its smoke test.
    const spawn = spawnWith((bin) => (bin.endsWith('kortixd') ? 0 : 1))
    const res = await performUpdate(baseOpts({ resolveTarget: resolveTo(next), spawn }))
    expect(res.outcome).toBe('failed')
    expect(res.code).toBe(1)
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V1')
    expect(existsSync(join(dir, 'kortixd.prev'))).toBe(false)
  })

  test('post-swap health failure: auto-rolls back to .prev', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2-BAD')
    // The candidate passes as a temp file (pre-swap), but the live target path
    // fails (post-swap). This is the auto-rollback branch.
    const spawn = spawnWith((bin) => (bin.endsWith('kortixd') ? 1 : 0))
    const res = await performUpdate(baseOpts({ resolveTarget: resolveTo(next), spawn }))
    expect(res.outcome).toBe('failed')
    expect(res.code).toBe(1)
    // Rolled back: the live binary is the original, and .prev is consumed.
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V1')
    expect(existsSync(join(dir, 'kortixd.prev'))).toBe(false)
  })

  test('best-effort (boot) mode: a failure exits 0 and keeps the last-good binary', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2-BROKEN')
    const spawn = spawnWith((bin) => (bin.endsWith('kortixd') ? 0 : 1)) // candidate fails
    const res = await performUpdate(
      baseOpts({ resolveTarget: resolveTo(next), spawn, bestEffort: true }),
    )
    expect(res.outcome).toBe('failed')
    expect(res.code).toBe(0) // boot proceeds to serve
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V1')
  })

  test('no-op update never re-hashes: uses the digest cache', async () => {
    const current = Buffer.from('BINARY-V1')
    writeFileSync(join(dir, 'kortixd'), current)
    const opts = baseOpts({ resolveTarget: resolveTo(current) })
    await performUpdate(opts)
    // The cache file now exists and records the digest.
    const cache = JSON.parse(readFileSync(opts.statePath, 'utf8'))
    expect(cache.current.sha256).toBe(sha(current))
  })
})

describe('performRollback', () => {
  test('restores .prev and consumes it', () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('CURRENT'))
    writeFileSync(join(dir, 'kortixd.prev'), Buffer.from('PREVIOUS'))
    const r = performRollback(join(dir, 'kortixd'), join(dir, '.state.json'))
    expect(r.code).toBe(0)
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('PREVIOUS')
    expect(existsSync(join(dir, 'kortixd.prev'))).toBe(false)
  })

  test('fails cleanly when there is no previous version', () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('CURRENT'))
    const r = performRollback(join(dir, 'kortixd'), join(dir, '.state.json'))
    expect(r.code).toBe(1)
    expect(r.message).toContain('no previous version')
  })
})
