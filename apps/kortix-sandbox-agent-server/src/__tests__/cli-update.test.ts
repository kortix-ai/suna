import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectSupervised,
  parseFlags,
  performRollback,
  performSupervisorRollback,
  performUpdate,
  type SpawnDeps,
  type UpdateOptions,
} from '../cli'

function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

let dir: string
let servers: Array<ReturnType<typeof Bun.serve>> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortixd-cli-'))
})
afterEach(() => {
  for (const server of servers) server.stop(true)
  servers = []
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

/**
 * A fake Kortix API serving the runtime-assets manifest and the agent binary
 * over a real socket: the boot path `kortixd update` takes. `claimed` is the
 * digest the manifest states (defaults to the bytes' own).
 */
function serve(bytes: Buffer, claimed = sha(bytes)): Partial<UpdateOptions> & { downloads: string[] } {
  const downloads: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/v1/runtime-assets/manifest') {
        return Response.json({ components: { agent: { sha256: claimed, path: '/v1/runtime-assets/agent' } } })
      }
      if (path === '/v1/runtime-assets/agent') {
        downloads.push(req.headers.get('authorization') ?? '')
        return new Response(bytes)
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return { apiUrl: `http://127.0.0.1:${server.port}/v1`, token: 'agent-token', downloads }
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
  test.each([false, true])('no-op when the current binary already matches the target (supervised: %p)', async (supervised) => {
    const current = Buffer.from('BINARY-V1')
    writeFileSync(join(dir, 'kortixd'), current)
    const stateDir = join(dir, 'state')
    const api = serve(current)
    const res = await performUpdate(baseOpts({ ...api, supervised, stateDir }))
    expect(res.outcome).toBe('current')
    expect(res.code).toBe(0)
    // Nothing downloaded, the running binary is untouched, nothing staged.
    expect(api.downloads).toEqual([])
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V1')
    expect(existsSync(join(dir, 'kortixd.prev'))).toBe(false)
    expect(existsSync(join(stateDir, 'agent.next'))).toBe(false)
  })

  test('happy path: swaps in the new binary and keeps .prev', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2')
    const api = serve(next)
    const res = await performUpdate(baseOpts(api))
    expect(api.downloads).toEqual(['Bearer agent-token'])
    expect(res.outcome).toBe('updated')
    expect(res.code).toBe(0)
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V2')
    expect(readFileSync(join(dir, 'kortixd.prev')).toString()).toBe('BINARY-V1')
  })

  test('digest mismatch: nothing is swapped', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2')
    // The manifest claims a digest that does not describe the bytes served.
    const res = await performUpdate(baseOpts(serve(next, sha(Buffer.from('SOMETHING-ELSE')))))
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
    const res = await performUpdate(baseOpts({ ...serve(next), spawn }))
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
    const res = await performUpdate(baseOpts({ ...serve(next), spawn }))
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
      baseOpts({ ...serve(next), spawn, bestEffort: true }),
    )
    expect(res.outcome).toBe('failed')
    expect(res.code).toBe(0) // boot proceeds to serve
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V1')
  })

  test('the no-op check trusts the (path, size, mtime) digest cache and re-hashes on a new mtime', async () => {
    const target = join(dir, 'kortixd')
    writeFileSync(target, Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2')
    // A cache entry that claims the on-disk bytes are already the target build.
    const st = statSync(target)
    const statePath = join(dir, '.state.json')
    writeFileSync(
      statePath,
      JSON.stringify({ current: { path: target, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), sha256: sha(next) } }),
    )
    const hit = await performUpdate(baseOpts({ ...serve(next), statePath }))
    expect(hit.outcome).toBe('current')

    // Same bytes, new mtime: the cache misses and the real digest decides.
    const later = new Date(st.mtimeMs + 5_000)
    utimesSync(target, later, later)
    const miss = await performUpdate(baseOpts({ ...serve(next), statePath }))
    expect(miss.outcome).toBe('updated')
    expect(readFileSync(target).toString()).toBe('BINARY-V2')
  })
})

describe('performUpdate — supervised (in-sandbox staging)', () => {
  test('stages agent.next + sha256, exits 75, and never touches the live binary', async () => {
    // The running binary is V1; the target build is V2.
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2')
    const stateDir = join(dir, 'state')
    const res = await performUpdate(
      baseOpts({ ...serve(next), supervised: true, stateDir }),
    )
    // Asks the caller to exit 75 so the supervisor performs the swap. The
    // literal is the contract: apps/sandbox/entrypoint.sh reads SWAP_CODE=75.
    expect(res.outcome).toBe('staged')
    expect(res.code).toBe(75)
    // The live binary is UNTOUCHED — kortixd never self-swaps in-sandbox.
    expect(readFileSync(join(dir, 'kortixd')).toString()).toBe('BINARY-V1')
    expect(existsSync(join(dir, 'kortixd.prev'))).toBe(false)
    // The staged slot the supervisor reads holds the verified V2 + its digest.
    expect(readFileSync(join(stateDir, 'agent.next')).toString()).toBe('BINARY-V2')
    expect(readFileSync(join(stateDir, 'agent.next.sha256'), 'utf8').trim()).toBe(sha(next))
  })

  test('a candidate that fails its smoke test is never staged', async () => {
    writeFileSync(join(dir, 'kortixd'), Buffer.from('BINARY-V1'))
    const next = Buffer.from('BINARY-V2-BROKEN')
    const stateDir = join(dir, 'state')
    // Any candidate whose path is not the live target fails its smoke test —
    // the staged temp file is a candidate, so it fails.
    const spawn = spawnWith((bin) => (bin.endsWith('kortixd') ? 0 : 1))
    const res = await performUpdate(
      baseOpts({ ...serve(next), supervised: true, stateDir, spawn }),
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
    await performUpdate(baseOpts({ ...serve(next), supervised: true, stateDir }))
    // Second pass: agent.next.sha256 already matches → staged, exit 75.
    const res = await performUpdate(
      baseOpts({ ...serve(next), supervised: true, stateDir }),
    )
    expect(res.outcome).toBe('staged')
    expect(res.code).toBe(75)
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
