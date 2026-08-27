import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_SWAP_EXIT_CODE,
  detectSupervised,
  parseFlags,
  performRollback,
  performSupervisorRollback,
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

describe('performUpdate — supervised (in-sandbox staging)', () => {
  test('stages agent.next + sha256, exits 75, and never touches the live binary', async () => {
    // The running binary is V1; the target build is V2.
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2')
    const stateDir = join(dir, 'state')
    const res = await performUpdate(
      baseOpts({ resolveTarget: resolveTo(next), supervised: true, stateDir }),
    )
    // Asks the caller to exit 75 so the supervisor performs the swap.
    expect(res.outcome).toBe('staged')
    expect(res.code).toBe(AGENT_SWAP_EXIT_CODE)
    // The live binary is UNTOUCHED — kortixd never self-swaps in-sandbox.
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V1')
    expect(existsSync(join(dir, 'kortixd.prev'))).toBe(false)
    // The staged slot the supervisor reads holds the verified V2 + its digest.
    expect(readFileSync(join(stateDir, 'agent.next')).toString()).toBe('BINARY-V2')
    expect(readFileSync(join(stateDir, 'agent.next.sha256'), 'utf8').trim()).toBe(sha(next))
  })

  test('no-op when the running binary already matches the target', async () => {
    const current = Buffer.from('BINARY-V1')
    writeFileSync(join(dir, 'kortixd'), current)
    const stateDir = join(dir, 'state')
    const res = await performUpdate(
      baseOpts({ resolveTarget: resolveTo(current), supervised: true, stateDir }),
    )
    expect(res.outcome).toBe('current')
    expect(res.code).toBe(0)
    expect(existsSync(join(stateDir, 'agent.next'))).toBe(false)
  })

  test('a candidate that fails its smoke test is never staged', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2-BROKEN')
    const stateDir = join(dir, 'state')
    // Any candidate whose path is not the live target fails its smoke test —
    // the staged temp file is a candidate, so it fails.
    const spawn = spawnWith((bin) => (bin.endsWith('kortixd') ? 0 : 1))
    const res = await performUpdate(
      baseOpts({ resolveTarget: resolveTo(next), supervised: true, stateDir, spawn }),
    )
    expect(res.outcome).toBe('failed')
    expect(existsSync(join(stateDir, 'agent.next'))).toBe(false)
    expect(existsSync(join(stateDir, 'agent.next.sha256'))).toBe(false)
  })

  test('a re-run that finds the build already staged asks for the swap without re-staging', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2')
    const stateDir = join(dir, 'state')
    // First pass stages it.
    await performUpdate(baseOpts({ resolveTarget: resolveTo(next), supervised: true, stateDir }))
    // Second pass: agent.next.sha256 already matches → staged, exit 75.
    const res = await performUpdate(
      baseOpts({ resolveTarget: resolveTo(next), supervised: true, stateDir }),
    )
    expect(res.outcome).toBe('staged')
    expect(res.code).toBe(AGENT_SWAP_EXIT_CODE)
    expect(res.message).toBe('already staged')
  })
})

describe('detectSupervised', () => {
  const prev = process.env.KORTIX_SUPERVISED
  afterEach(() => {
    if (prev === undefined) delete process.env.KORTIX_SUPERVISED
    else process.env.KORTIX_SUPERVISED = prev
  })
  test('KORTIX_SUPERVISED=1 selects the supervised path', () => {
    process.env.KORTIX_SUPERVISED = '1'
    expect(detectSupervised('/anything/kortixd')).toBe(true)
  })
  test('a normal standalone binary is not supervised', () => {
    delete process.env.KORTIX_SUPERVISED
    expect(detectSupervised(join(dir, 'kortixd'))).toBe(false)
  })
})

describe('performSupervisorRollback', () => {
  test('with a predecessor: restores agent.prev and latches the pin', () => {
    const state = join(dir, 'state')
    // Prepare the supervisor state as it looks after one update.
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'agent.current'), 'UPDATED')
    writeFileSync(join(state, 'agent.prev'), 'PREVIOUS')
    writeFileSync(join(state, 'agent.next'), 'STAGED')
    writeFileSync(join(state, 'agent.next.sha256'), 'deadbeef\n')
    const r = performSupervisorRollback(state)
    expect(r.code).toBe(0)
    expect(readFileSync(join(state, 'agent.current')).toString()).toBe('PREVIOUS')
    expect(existsSync(join(state, 'agent.prev'))).toBe(false)
    expect(existsSync(join(state, 'agent.pinned'))).toBe(true)
    // A staged build is discarded so the box does not re-stage what was rejected.
    expect(existsSync(join(state, 'agent.next'))).toBe(false)
    expect(existsSync(join(state, 'agent.next.sha256'))).toBe(false)
  })

  test('no predecessor: drops back to the baked floor and pins', () => {
    const state = join(dir, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'agent.current'), 'FIRST-UPDATE-BAD')
    const r = performSupervisorRollback(state)
    expect(r.code).toBe(0)
    // Removing the override drops the box back to the immutable baked binary.
    expect(existsSync(join(state, 'agent.current'))).toBe(false)
    expect(existsSync(join(state, 'agent.pinned'))).toBe(true)
  })

  test('nothing to roll back: no agent.current → non-zero, box already on baked', () => {
    const state = join(dir, 'state')
    mkdirSync(state, { recursive: true })
    const r = performSupervisorRollback(state)
    expect(r.code).toBe(1)
    expect(r.message).toContain('no update to roll back')
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
