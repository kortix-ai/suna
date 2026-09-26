import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_SWAP_EXIT_CODE,
  applyStagedAssetsIfIdle,
  reconcileRuntimeAssets,
  registerAgentSwapBlocker,
  requestAgentSwapIfIdle,
  resetAgentSwapBlockersForTests,
  resetRuntimeConvergenceForTests,
  noteRuntimeConvergence,
  runtimeConvergenceReport,
  resetRuntimeConvergenceReportForTests,
  overlayHash,
  type RuntimeAssetsOptions,
} from '../runtime-assets'
import {
  createOpenCodeAssetsService,
  type OpenCodeAssetsOptions,
  type OpenCodeAssetsRuntime,
} from '../harness/open-code/assets'

/**
 * Convergent runtime — the v2 half of `reconcileRuntimeAssets`.
 *
 * Everything here is a way the mechanism could break a box: a manifest that
 * moves backwards, an artifact that does not match its digest, a swap requested
 * while a turn is running, an opencode binary installed without its matching
 * plugin. The v1 half stays covered by runtime-assets.test.ts, and the "a v1
 * manifest still converges the CLI" case below is the compatibility contract
 * for daemons that talk to an API which has not shipped v2 yet.
 */

const API_URL = 'https://api.test.invalid'
const TOKEN = 'kortix_pat_test'

const dirs: string[] = []

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-convergence-'))
  dirs.push(dir)
  // Every real box has `/opt/kortix/opencode.current` — the image creates it
  // (apps/sandbox/Dockerfile:205) and lifecycle.ts LAUNCHES through it. The
  // rollback half reads and rewrites the same link, so a fixture without one is
  // not a box: it is a box whose opencode we could not put back.
  const opencodeInstalled = join(dir, 'opencode-installed.exe')
  await Bun.write(opencodeInstalled, '#!/bin/sh\nexit 0\n')
  // Executable, because `publishOpencodeNativeLink` refuses a target it cannot
  // exec — the rollback republishes through that same guard.
  await chmod(opencodeInstalled, 0o755)
  await mkdir(join(dir, 'state'), { recursive: true })
  await symlink(opencodeInstalled, join(dir, 'state', 'opencode.current'))
  return {
    opencodeInstalled,
    root: dir,
    cliPath: join(dir, 'bin', 'kortix'),
    agentBakedPath: join(dir, 'usr', 'kortix-agent'),
    stateDir: join(dir, 'state'),
    agentNext: join(dir, 'state', 'agent.next'),
    agentNextSha: join(dir, 'state', 'agent.next.sha256'),
    agentCurrent: join(dir, 'state', 'agent.current'),
    agentPinned: join(dir, 'state', 'agent.pinned'),
    skillsDir: join(dir, 'opt', 'managed-skills'),
    statePath: join(dir, 'state', 'runtime-assets-state.json'),
    depsDir: join(dir, 'opencode-config-deps'),
    opencodeCurrent: join(dir, 'state', 'opencode.current'),
    opencodePrev: join(dir, 'state', 'opencode.prev'),
    opencodePinned: join(dir, 'state', 'opencode.pinned'),
  }
}

afterEach(async () => {
  // Module-level state: clear it on the way OUT too, or the next file in this
  // bun process inherits it (see test-state-reset-tripwire.test.ts).
  resetRuntimeConvergenceReportForTests()
  resetAgentSwapBlockersForTests()
  resetRuntimeConvergenceForTests()
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true })
})

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const SKILL_FILES = [{ path: 'kortix-system/SKILL.md', content: 'body\n' }]
const SKILLS_HASH = overlayHash(SKILL_FILES)

const CLI_BYTES = 'CLI-BYTES'
const AGENT_BYTES = 'AGENT-BYTES-v2'

interface ManifestOptions {
  build?: number
  agentSha?: string
  agentPath?: string
  agentSelfUpdate?: boolean
  opencodeVersion?: string
  /** Emit a v1-only document — no `components`, no `build`, no `policy`. */
  v1Only?: boolean
}

function buildManifest(opts: ManifestOptions = {}): Record<string, unknown> {
  const v1 = {
    cli_version: '0.13.1-dev.abc1234',
    cli_sha256: sha(CLI_BYTES),
    cli_size: CLI_BYTES.length,
    managed_skills_hash: SKILLS_HASH,
  }
  if (opts.v1Only) return v1
  return {
    ...v1,
    build: opts.build ?? 1_755_700_000,
    components: {
      agent: {
        version: '0.13.1-dev.abc1234',
        sha256: opts.agentSha ?? sha(AGENT_BYTES),
        size: AGENT_BYTES.length,
        path: opts.agentPath ?? '/v1/runtime-assets/agent',
      },
      cli: { version: '0.13.1-dev.abc1234', sha256: sha(CLI_BYTES), size: CLI_BYTES.length },
      opencode: { version: opts.opencodeVersion ?? '1.18.19', source: 'npm' },
      'managed-skills': { hash: SKILLS_HASH, count: SKILL_FILES.length },
    },
    policy: { agent_self_update: opts.agentSelfUpdate ?? true },
  }
}

function stubFetch(opts: ManifestOptions & { agentBody?: string; agentStatus?: number } = {}) {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/runtime-assets/manifest')) return Response.json(buildManifest(opts))
    if (url.endsWith('/runtime-assets/cli')) return new Response(CLI_BYTES)
    if (url.endsWith('/runtime-assets/agent')) {
      if (opts.agentStatus && opts.agentStatus !== 200) {
        return new Response('nope', { status: opts.agentStatus })
      }
      return new Response(opts.agentBody ?? AGENT_BYTES)
    }
    if (url.endsWith('/runtime-assets/managed-skills')) {
      return Response.json({ hash: SKILLS_HASH, files: SKILL_FILES })
    }
    return new Response('unexpected', { status: 500 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

async function run(
  ws: Awaited<ReturnType<typeof workspace>>,
  stub: ReturnType<typeof stubFetch>,
  extra: RuntimeAssetsOptions & OpenCodeAssetsOptions & { runtime?: OpenCodeAssetsRuntime } = {},
) {
  const {
    runtime,
    installOpencode,
    readOpencodeVersion,
    opencodeBinaryExists,
    turnProbe,
    opencodeDepsDir,
    installPluginDeps,
    opencodeCurrentLinkPath,
    opencodePrevLinkPath,
    opencodePinnedPath,
    ...shared
  } = extra
  return reconcileRuntimeAssets({
    apiUrl: API_URL,
    token: TOKEN,
    // The fixtures are text files, not executables. The real probe would spawn
    // them and get a non-zero exit, which is exactly what it is FOR — so every
    // case that is not about the probe says "it ran" and the cases that are
    // about it override this.
    execProbe: async () => 0,
    cliPath: ws.cliPath,
    managedSkillsDir: ws.skillsDir,
    statePath: ws.statePath,
    agentStateDir: ws.stateDir,
    agentBakedPath: ws.agentBakedPath,
    fetchImpl: stub.impl,
    ...shared,
    assets: shared.assets ?? createOpenCodeAssetsService(runtime, {
      installOpencode,
      readOpencodeVersion,
      opencodeBinaryExists,
      turnProbe,
      opencodeDepsDir,
      installPluginDeps,
      // Never the real `/opt/kortix/*` paths: the rollback half reads and writes
      // them, and a unit test must not depend on (or touch) a machine's own box
      // layout.
      opencodeCurrentLinkPath: opencodeCurrentLinkPath ?? ws.opencodeCurrent,
      opencodePrevLinkPath: opencodePrevLinkPath ?? ws.opencodePrev,
      opencodePinnedPath: opencodePinnedPath ?? ws.opencodePinned,
    }),
  })
}

/** A seam whose opencode is reachable and idle unless a test says otherwise. */
function opencodeSeam(restarts: string[] = []) {
  return {
    runtime: {
      getInternalUrl: () => 'http://127.0.0.1:4096',
      workspace: () => '/workspace',
      restart: async () => {
        restarts.push('restart')
      },
    },
  }
}

describe('epoch guard', () => {
  test('a manifest whose build is LOWER than the converged one is ignored', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'STALE-CLI')
    await Bun.write(ws.statePath, JSON.stringify({ build: 200 }))
    const stub = stubFetch({ build: 100 })

    const result = await run(ws, stub)

    expect(result.cli).toBe('skipped')
    expect(result.skills).toBe('skipped')
    expect(result.build).toBe(200)
    expect(result.reason).toContain('older than converged build 200')
    // Nothing beyond the manifest was even requested: the whole point is that a
    // rolling deploy's older API cannot make this box re-download anything.
    expect(stub.calls).toEqual([`${API_URL}/v1/runtime-assets/manifest`])
    expect(await readFile(ws.cliPath, 'utf8')).toBe('STALE-CLI')
  })

  test('an EQUAL build is accepted — re-converging is idempotent, not a flap', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'STALE-CLI')
    await Bun.write(ws.statePath, JSON.stringify({ build: 200 }))

    const result = await run(ws, stubFetch({ build: 200 }))

    expect(result.cli).toBe('updated')
    expect(result.build).toBe(200)
    expect(await readFile(ws.cliPath, 'utf8')).toBe(CLI_BYTES)
  })

  test('a higher build is converged and recorded as the new floor', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'STALE-CLI')
    await Bun.write(ws.statePath, JSON.stringify({ build: 100 }))

    const result = await run(ws, stubFetch({ build: 300 }))

    expect(result.build).toBe(300)
    const state = JSON.parse(await readFile(ws.statePath, 'utf8')) as { build?: number }
    expect(state.build).toBe(300)
  })
})

describe('agent convergence — stage only', () => {
  test('a digest mismatch stages agent.next + .sha256, and swaps NOTHING', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')
    const stub = stubFetch()

    const result = await run(ws, stub)

    expect(result.agent).toBe('staged')
    expect(result.agentSwapPending).toBe(true)
    expect(await readFile(ws.agentNext, 'utf8')).toBe(AGENT_BYTES)
    expect((await readFile(ws.agentNextSha, 'utf8')).trim()).toBe(sha(AGENT_BYTES))
    expect((await stat(ws.agentNext)).mode & 0o777).toBe(0o755)
    // The running binary is untouched, and no `agent.current` was invented:
    // installing is the supervisor's job, not ours.
    expect(await readFile(ws.agentBakedPath, 'utf8')).toBe('AGENT-BYTES-v1')
    expect(await stat(ws.agentCurrent).catch(() => null)).toBeNull()
  })

  test('a matching digest downloads nothing at all', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    const stub = stubFetch()

    const result = await run(ws, stub)

    expect(result.agent).toBe('current')
    expect(result.agentSwapPending).toBeUndefined()
    expect(stub.calls.some((url) => url.endsWith('/runtime-assets/agent'))).toBe(false)
  })

  test('agent.current is what gets hashed once an update is installed', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    // The baked floor is an OLD build; the installed update is the new one.
    // Hashing the floor here would re-stage the same ~96 MB on every start.
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')
    await Bun.write(ws.agentCurrent, AGENT_BYTES)
    const stub = stubFetch()

    const result = await run(ws, stub)

    expect(result.agent).toBe('current')
    expect(stub.calls.some((url) => url.endsWith('/runtime-assets/agent'))).toBe(false)
  })

  test('a staged artifact that does not match its digest is REJECTED', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')
    // The manifest promises one digest; the body delivers different bytes.
    const stub = stubFetch({ agentBody: 'TRUNCATED' })

    const result = await run(ws, stub)

    expect(result.agent).toBe('failed')
    expect(result.agentSwapPending).toBeUndefined()
    expect(await stat(ws.agentNext).catch(() => null)).toBeNull()
    expect(await stat(ws.agentNextSha).catch(() => null)).toBeNull()
    expect(await readFile(ws.agentBakedPath, 'utf8')).toBe('AGENT-BYTES-v1')
    // No temp file left behind in the state dir.
    const left = await readdir(ws.stateDir)
    expect(left.filter((e) => e.includes('download'))).toEqual([])
  })

  test('policy.agent_self_update:false stops the rollout before any download', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')
    const stub = stubFetch({ agentSelfUpdate: false })

    const result = await run(ws, stub)

    expect(result.agent).toBe('skipped')
    expect(result.reasons?.agent).toBe('policy.agent_self_update is false')
    expect(stub.calls.some((url) => url.endsWith('/runtime-assets/agent'))).toBe(false)
    expect(await stat(ws.agentNext).catch(() => null)).toBeNull()
    // The kill switch governs the agent ONLY — the CLI still converges.
    expect(result.cli).toBe('current')
  })

  test('flipping the kill switch RETRACTS a build already staged', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')
    // The box staged the bad build before the switch was flipped. The
    // supervisor knows nothing about policy, so if this is left on disk it
    // installs at the next start and the kill switch stopped nothing.
    await run(ws, stubFetch())
    expect(await stat(ws.agentNext).catch(() => null)).not.toBeNull()

    const result = await run(ws, stubFetch({ agentSelfUpdate: false }))

    expect(result.agent).toBe('skipped')
    expect(await stat(ws.agentNext).catch(() => null)).toBeNull()
    expect(await stat(ws.agentNextSha).catch(() => null)).toBeNull()
  })

  test('a pinned box (rollback latched) never re-stages the build it rejected', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')
    await Bun.write(ws.agentPinned, '')
    const stub = stubFetch()

    const result = await run(ws, stub)

    expect(result.agent).toBe('skipped')
    expect(result.reasons?.agent).toBe('updates pinned after a rollback')
    expect(stub.calls.some((url) => url.endsWith('/runtime-assets/agent'))).toBe(false)
  })

  test('an artifact already staged is not downloaded a second time', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')
    await run(ws, stubFetch())

    const second = stubFetch()
    const result = await run(ws, second)

    expect(result.agent).toBe('staged')
    expect(result.agentSwapPending).toBe(true)
    expect(second.calls.some((url) => url.endsWith('/runtime-assets/agent'))).toBe(false)
  })

  test('a staged artifact the API no longer advertises is discarded', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    // Running binary already matches, but a stale artifact sits staged. Left
    // alone, the supervisor would install it at the next start.
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await Bun.write(ws.agentNext, 'AGENT-BYTES-v0')
    await Bun.write(ws.agentNextSha, `${sha('AGENT-BYTES-v0')}\n`)

    const result = await run(ws, stubFetch())

    expect(result.agent).toBe('current')
    expect(await stat(ws.agentNext).catch(() => null)).toBeNull()
    expect(await stat(ws.agentNextSha).catch(() => null)).toBeNull()
  })

  test('an agent download that 500s leaves the box exactly as it was', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')

    const result = await run(ws, stubFetch({ agentStatus: 500 }))

    expect(result.agent).toBe('failed')
    expect(result.reasons?.agent).toBe('agent download returned 500')
    expect(await stat(ws.agentNext).catch(() => null)).toBeNull()
    // The rest of the pass still converged.
    expect(result.skills).toBe('updated')
  })

  test('a manifest path pointing off this API is refused; the built-in route is used', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')
    const stub = stubFetch({ agentPath: 'https://evil.test/agent' })

    const result = await run(ws, stub)

    expect(result.agent).toBe('staged')
    // Assert the POSITIVE — every fetch stayed on this API's origin. The
    // negative form (`no url starts with https://evil.test`) still passes for
    // `https://evil.test.attacker.com`, which is precisely the incomplete
    // substring sanitization this test exists to rule out. Comparing parsed
    // origins cannot be fooled that way.
    const apiOrigin = new URL(API_URL).origin
    for (const url of stub.calls) {
      expect(new URL(url).origin).toBe(apiOrigin)
    }
    expect(stub.calls).toContain(`${API_URL}/v1/runtime-assets/agent`)
  })
})

describe('opencode convergence — idle only', () => {
  async function bakeDeps(ws: Awaited<ReturnType<typeof workspace>>, pin: string) {
    await Bun.write(
      join(ws.depsDir, 'package.json'),
      `${JSON.stringify({ name: 'kortix-opencode-config', dependencies: { '@opencode-ai/plugin': pin, zod: '4.1.8' } }, null, 2)}\n`,
    )
  }

  test('a version mismatch installs the exact version and refreshes the plugin pin', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    const installs: string[] = []
    const depsInstalls: string[] = []
    const restarts: string[] = []

    const result = await run(ws, stubFetch(), {
      ...opencodeSeam(restarts),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => '1.17.11',
      turnProbe: async () => false,
      installOpencode: async (version: string) => {
        installs.push(version)
      },
      installPluginDeps: async (dir: string) => {
        depsInstalls.push(dir)
      },
    })

    expect(result.opencode).toBe('updated')
    expect(installs).toEqual(['1.18.19'])
    // Same step, always: a binary and a plugin that disagree is the stall this
    // pairing exists to prevent.
    const pkg = JSON.parse(await readFile(join(ws.depsDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['@opencode-ai/plugin']).toBe('1.18.19')
    expect(pkg.dependencies.zod).toBe('4.1.8')
    expect(depsInstalls).toEqual([ws.depsDir])
    expect(restarts).toEqual(['restart'])
  })

  test('a turn in flight defers everything — no install, no restart', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    const installs: string[] = []
    const restarts: string[] = []

    const result = await run(ws, stubFetch(), {
      ...opencodeSeam(restarts),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => '1.17.11',
      turnProbe: async () => true,
      installOpencode: async (v: string) => {
        installs.push(v)
      },
      installPluginDeps: async () => {
        throw new Error("a busy box must never install plugin deps")
      },
    })

    expect(result.opencode).toBe('skipped')
    expect(result.reasons?.opencode).toBe('a turn is in flight')
    expect(installs).toEqual([])
    expect(restarts).toEqual([])
    const pkg = JSON.parse(await readFile(join(ws.depsDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['@opencode-ai/plugin']).toBe('1.17.11')
  })

  test('UNREADABLE turn state counts as busy', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    const installs: string[] = []

    const result = await run(ws, stubFetch(), {
      ...opencodeSeam(),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => '1.17.11',
      turnProbe: async () => null,
      installOpencode: async (v: string) => {
        installs.push(v)
      },
      installPluginDeps: async () => {
        throw new Error("a busy box must never install plugin deps")
      },
    })

    expect(result.opencode).toBe('skipped')
    expect(result.reasons?.opencode).toBe('turn state unreadable')
    expect(installs).toEqual([])
  })

  test('a matching binary AND pin is a no-op', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.18.19')
    const installs: string[] = []

    const result = await run(ws, stubFetch(), {
      ...opencodeSeam(),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => '1.18.19',
      turnProbe: async () => {
        throw new Error('the turn probe must not be consulted for a no-op')
      },
      installOpencode: async (v: string) => {
        installs.push(v)
      },
    })

    expect(result.opencode).toBe('current')
    expect(installs).toEqual([])
  })

  test('a pin that drifted from a matching binary is repaired without a restart', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    const installs: string[] = []
    const restarts: string[] = []

    const result = await run(ws, stubFetch(), {
      ...opencodeSeam(restarts),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => '1.18.19',
      turnProbe: async () => false,
      installOpencode: async (v: string) => {
        installs.push(v)
      },
      installPluginDeps: async () => {},
    })

    expect(result.opencode).toBe('updated')
    expect(installs).toEqual([])
    // The plugin is read when opencode boots, so the refreshed pin takes effect
    // on its own. Cutting a session short for it would buy nothing.
    expect(restarts).toEqual([])
  })

  test('a malformed version from the manifest is refused, never executed', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    const installs: string[] = []

    const result = await run(ws, stubFetch({ opencodeVersion: '1.18.19; rm -rf /' }), {
      ...opencodeSeam(),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => '1.17.11',
      turnProbe: async () => false,
      installOpencode: async (v: string) => {
        installs.push(v)
      },
    })

    expect(result.opencode).toBe('skipped')
    expect(result.reasons?.opencode).toBe('manifest opencode version is malformed')
    expect(installs).toEqual([])
  })

  test('a missing managed opencode binary is installed when the runtime is unreadable', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    const installs: string[] = []

    const result = await run(ws, stubFetch(), {
      ...opencodeSeam(),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => null,
      opencodeBinaryExists: async () => false,
      turnProbe: async () => false,
      installOpencode: async (v: string) => {
        installs.push(v)
      },
    })

    expect(result.opencode).toBe('updated')
    expect(result.reasons?.opencode).toBeUndefined()
    expect(installs).toEqual(['1.18.19'])
  })

  test('an existing managed binary is not replaced during a transient unreadable runtime', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    const installs: string[] = []

    const result = await run(ws, stubFetch(), {
      ...opencodeSeam(),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => null,
      opencodeBinaryExists: async () => true,
      installOpencode: async (v: string) => {
        installs.push(v)
      },
    })

    expect(result.opencode).toBe('skipped')
    expect(result.reasons?.opencode).toBe('opencode did not report its version')
    expect(installs).toEqual([])
  })

  test('a failing install leaves the pin alone and never restarts', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    const restarts: string[] = []

    const result = await run(ws, stubFetch(), {
      ...opencodeSeam(restarts),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => '1.17.11',
      turnProbe: async () => false,
      installOpencode: async () => {
        throw new Error('npm registry unreachable')
      },
    })

    expect(result.opencode).toBe('failed')
    expect(restarts).toEqual([])
    const pkg = JSON.parse(await readFile(join(ws.depsDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['@opencode-ai/plugin']).toBe('1.17.11')
    // The rest of the pass is unaffected — one failure never costs the others.
    expect(result.cli).toBe('current')
    expect(result.skills).toBe('updated')
  })

  test('no live runtime in this process → reported, not attempted', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)

    const result = await run(ws, stubFetch())

    expect(result.opencode).toBe('skipped')
    expect(result.reasons?.opencode).toBe('no opencode runtime in this process')
  })
})

describe('v1 compatibility', () => {
  test('a v1-only manifest still converges the CLI and reports no v2 components', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI')
    await Bun.write(ws.agentBakedPath, 'AGENT-BYTES-v1')
    const stub = stubFetch({ v1Only: true })

    const result = await run(ws, stub)

    expect(result.cli).toBe('updated')
    expect(result.skills).toBe('updated')
    expect(await readFile(ws.cliPath, 'utf8')).toBe(CLI_BYTES)
    // An API that has never heard of `components` says nothing about the agent
    // or opencode — which is different from saying "skip them".
    expect(result.agent).toBeUndefined()
    expect(result.opencode).toBeUndefined()
    expect(result.build).toBeUndefined()
    // And nothing was staged from a manifest that never described an agent.
    expect(await stat(ws.agentNext).catch(() => null)).toBeNull()
    expect(stub.calls.some((url) => url.endsWith('/runtime-assets/agent'))).toBe(false)
  })

  test('a v1 manifest is never blocked by a build recorded earlier', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI')
    await Bun.write(ws.statePath, JSON.stringify({ build: 900 }))

    const result = await run(ws, stubFetch({ v1Only: true }))

    expect(result.cli).toBe('updated')
  })
})

describe('requestAgentSwapIfIdle', () => {
  async function stage(ws: Awaited<ReturnType<typeof workspace>>) {
    await Bun.write(ws.agentNext, AGENT_BYTES)
    await Bun.write(ws.agentNextSha, `${sha(AGENT_BYTES)}\n`)
  }

  test('exits 75 when nothing is in flight', async () => {
    const ws = await workspace()
    await stage(ws)
    const exits: number[] = []

    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })

    expect(decision).toBe('exited')
    expect(exits).toEqual([AGENT_SWAP_EXIT_CODE])
    expect(AGENT_SWAP_EXIT_CODE).toBe(75)
  })

  // Every reason the daemon keeps running instead of taking the swap. Exiting
  // takes the harness, the proxy and every PTY down, so "cannot tell" is busy.
  const busyPty = () => true
  const throwingPty = () => {
    throw new Error('registry unavailable')
  }
  test.each([
    ['a live turn', { turn: true }, 'turn-in-flight'],
    ['unreadable turn state', { turn: null }, 'turn-state-unknown'],
    ['a registered blocker (an open PTY)', { blocker: busyPty }, 'attached'],
    ['a blocker that throws', { blocker: throwingPty }, 'attached'],
    ['nothing staged', { staged: 'none' }, 'nothing-staged'],
    ['a digest side-car without its binary', { staged: 'sidecar-only' }, 'nothing-staged'],
    ['a pinned box', { pinned: true }, 'pinned'],
    ['no turn oracle configured', { configured: false }, 'not-configured'],
    // The boot reconcile fires seconds after opencode is ready, the moment a
    // first prompt arrives. The supervisor promotes before every launch anyway.
    ['a freshly booted daemon', { uptimeMs: 20_000 }, 'too-young'],
  ] as const)('%s keeps the daemon running', async (_name, row, decision) => {
    const input = row as {
      turn?: boolean | null
      blocker?: () => boolean
      staged?: 'none' | 'sidecar-only'
      pinned?: boolean
      configured?: boolean
      uptimeMs?: number
    }
    const ws = await workspace()
    if (input.staged === 'sidecar-only') await Bun.write(ws.agentNextSha, `${sha(AGENT_BYTES)}\n`)
    else if (input.staged !== 'none') await stage(ws)
    if (input.pinned) await Bun.write(ws.agentPinned, '')
    if (input.blocker) registerAgentSwapBlocker('pty', input.blocker)
    const exits: number[] = []

    const result = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: input.uptimeMs ?? 10 * 60_000,
      ...(input.configured === false ? {} : { turnInFlight: async () => ('turn' in input ? (input.turn as boolean | null) : false) }),
      exit: (code) => exits.push(code),
    })

    expect(result).toBe(decision)
    expect(exits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Observability. A box that self-heals silently is only marginally better than
// one that never heals: you still cannot answer "is the fleet current?". These
// pin the reporting contract /kortix/health exposes.
// ---------------------------------------------------------------------------
describe('runtime convergence report', () => {
  beforeEach(() => {
    resetRuntimeConvergenceReportForTests()
  })
  const reportDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcr-'))
    dirs.push(dir)
    return dir
  }

  test('starts empty — a box that has never reconciled must not look converged', async () => {
    const report = await runtimeConvergenceReport(reportDir())
    expect(report.build).toBeNull()
    expect(report.at).toBeNull()
    expect(report.agentSwapPending).toBe(false)
    expect(report.pinned).toBe(false)
  })

  test('records the epoch and per-component outcome of the last pass', async () => {
    noteRuntimeConvergence({
      cli: 'current',
      skills: 'current',
      agent: 'staged',
      opencode: 'updated',
      build: 1787241641,
      agentSwapPending: true,
    })
    const report = await runtimeConvergenceReport(reportDir())
    expect(report.build).toBe(1787241641)
    expect(report.components).toEqual({
      cli: 'current',
      skills: 'current',
      agent: 'staged',
      opencode: 'updated',
    })
    expect(report.agentSwapPending).toBe(true)
    expect(typeof report.at).toBe('string')
  })

  test('omits agent/opencode for a v1 manifest instead of claiming they were skipped', async () => {
    noteRuntimeConvergence({ cli: 'current', skills: 'current' })
    const report = await runtimeConvergenceReport(reportDir())
    expect(report.components).toEqual({ cli: 'current', skills: 'current' })
    expect(report.build).toBeNull()
  })

  // WHAT IS RUNNING, not what the last pass DID. `build` is written even when a
  // half failed ("It is recorded even when a half failed"), and `components`
  // reports outcomes, so neither answers "which bytes are on this box". Without
  // that the API cannot tell a current box from a behind one and has to send a
  // refresh on every turn. The persisted truth was already on disk in
  // runtime-assets-state.json and simply was not surfaced.
  test('reports the on-disk digests after a restart emptied the in-memory pass', async () => {
    const dir = reportDir()
    const statePath = join(dir, 'runtime-assets-state.json')
    writeFileSync(
      statePath,
      JSON.stringify({
        cli_sha256: 'a'.repeat(64),
        managed_skills_hash: 'b'.repeat(64),
        agent_sha256: 'c'.repeat(64),
        agent_path: '/opt/kortix/agent.current',
        staged_agent_sha256: 'd'.repeat(64),
        opencode_version: '1.18.23',
        build: 1787241641,
      }),
    )
    // `lastConvergence` is empty — exactly the state every daemon restart is in
    // until its first pass completes.
    const report = await runtimeConvergenceReport(dir, statePath)
    expect(report.running).toEqual({
      cli_sha256: 'a'.repeat(64),
      managed_skills_hash: 'b'.repeat(64),
      agent_sha256: 'c'.repeat(64),
      agent_path: '/opt/kortix/agent.current',
      staged_agent_sha256: 'd'.repeat(64),
      opencode_version: '1.18.23',
      build: 1787241641,
    })
    // The pass-level fields stay honest about having no pass yet.
    expect(report.build).toBeNull()
    expect(report.at).toBeNull()
  })

  test('answers all-null when the box has no state file at all', async () => {
    const dir = reportDir()
    const report = await runtimeConvergenceReport(dir, join(dir, 'missing.json'))
    expect(report.running).toEqual({
      cli_sha256: null,
      managed_skills_hash: null,
      agent_sha256: null,
      agent_path: null,
      staged_agent_sha256: null,
      opencode_version: null,
      build: null,
    })
  })

  test('reads the rollback latch from DISK, not from the last pass', async () => {
    // The SUPERVISOR writes agent.pinned between daemon runs, so a value cached
    // at reconcile time is stale exactly when someone is looking: the first
    // health check after a rollback.
    const dir = reportDir()
    noteRuntimeConvergence({ cli: 'current', skills: 'current', build: 7 })
    expect((await runtimeConvergenceReport(dir)).pinned).toBe(false)
    writeFileSync(join(dir, 'agent.pinned'), '')
    expect((await runtimeConvergenceReport(dir)).pinned).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WHAT PROVES A NEW BINARY WORKS BEFORE THE OLD ONE IS GIVEN UP.
//
// The honest starting answer was: nothing. `replaceCli` verified the digest and
// renamed; nothing ever executed the file. `stageAgentBinary` verified the
// digest; the first thing to run the artifact was the supervisor, AFTER it had
// already replaced the daemon, with `HEALTHY_AFTER_S=60` as the only safety net.
// A digest proves the bytes arrived intact. It does not prove they run on this
// kernel and this architecture — a wrong-arch artifact passes every digest check
// and then cannot exec.
//
// EXIT CODE, NOT VERSION STRING, and that is deliberate. `kortix --version`
// prints a DECORATED header (`header('Kortix CLI', VERSION)`), so an equality
// check against the manifest's `cli_version` would assert a formatting detail,
// not a fact — and a false negative there would freeze CLI updates fleet-wide
// while looking like a safety feature. `opencode --version` prints a bare
// version, which is why `installOpencodeVersion` can and does compare it.
// ---------------------------------------------------------------------------
describe('a candidate binary must run before it replaces a working one', () => {
  test('a CLI that cannot exec is NOT renamed into place', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'WORKING-CLI')
    const stub = stubFetch()
    const probed: string[] = []

    const result = await run(ws, stub, {
      execProbe: async (path) => {
        probed.push(path)
        return 126 // "found but not executable" — the wrong-arch shape
      },
    })

    expect(result.cli).toBe('failed')
    expect(result.reasons?.cli).toContain('did not run')
    // The working binary is untouched. That is the whole point.
    expect(await readFile(ws.cliPath, 'utf8')).toBe('WORKING-CLI')
    // It probed a TEMP file beside the target, never the installed one.
    expect(probed.some((path) => path.includes('.kortix.download.'))).toBe(true)
    expect(probed).not.toContain(ws.cliPath)
  })

  test('a CLI that runs is installed, and the probe saw the candidate', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI')
    const stub = stubFetch()
    const probed: string[] = []

    const result = await run(ws, stub, {
      execProbe: async (path) => {
        probed.push(path)
        return 0
      },
    })

    expect(result.cli).toBe('updated')
    expect(await readFile(ws.cliPath, 'utf8')).toBe(CLI_BYTES)
    expect(probed.some((path) => path.includes('.kortix.download.'))).toBe(true)
    expect(probed).not.toContain(ws.cliPath)
  })

  test('an agent that cannot exec is NOT staged for the supervisor', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'OLD-AGENT')
    const stub = stubFetch()

    const result = await run(ws, stub, { execProbe: async () => 1 })

    expect(result.agent).toBe('failed')
    expect(result.reasons?.agent).toContain('did not run')
    expect(result.agentSwapPending).toBeUndefined()
    // Nothing for the supervisor to promote.
    expect(await stat(ws.agentNext).then(() => true, () => false)).toBe(false)
  })

  test('an agent that runs is staged exactly as before', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, 'OLD-AGENT')
    const stub = stubFetch()

    const result = await run(ws, stub, { execProbe: async () => 0 })

    expect(result.agent).toBe('staged')
    expect(result.agentSwapPending).toBe(true)
    expect(await readFile(ws.agentNext, 'utf8')).toBe(AGENT_BYTES)
  })
})

// ---------------------------------------------------------------------------
// THE TRIGGER THAT WAS MISSING. `scheduleRuntimeAssetsReconcile` had exactly
// two non-test call sites — `runtimeReadyTail` (boot) and `POST /kortix/refresh`
// — and `requestAgentSwapIfIdle` is reached only from the tail of that same
// pass. The boot pass fires seconds after `opencode-ready`, so it always
// answered `too-young` against `AGENT_SWAP_MIN_UPTIME_MS = 5 min`, and no later
// pass existed. A long-lived box therefore staged a daemon and NEVER installed
// it.
//
// The uptime floor is a BOOT-FLAP guard: a restart moments after opencode-ready
// is a readiness flap on the session-start hot path. A `session.idle` frame is
// the opposite of that — a turn just finished, so the box is provably past boot
// and provably not serving anyone. The floor is therefore waived at an idle
// boundary and NOWHERE else.
// ---------------------------------------------------------------------------
describe('the idle boundary is a real swap trigger, not a timer', () => {
  async function staged(ws: Awaited<ReturnType<typeof workspace>>) {
    await Bun.write(ws.agentNext, AGENT_BYTES)
    await Bun.write(ws.agentNextSha, `${sha(AGENT_BYTES)}\n`)
  }

  test('a young box still swaps at an idle boundary — the boot-flap floor is waived', async () => {
    const ws = await workspace()
    await staged(ws)
    const exits: number[] = []
    const decision = await applyStagedAssetsIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 3_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })
    expect(decision).toBe('exited')
    expect(exits).toEqual([AGENT_SWAP_EXIT_CODE])
  })

  test('the same young box is refused OUTSIDE an idle boundary', async () => {
    const ws = await workspace()
    await staged(ws)
    const exits: number[] = []
    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 3_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })
    expect(decision).toBe('too-young')
    expect(exits).toEqual([])
  })

  test('an open PTY still blocks it — the shell dies with the daemon', async () => {
    const ws = await workspace()
    await staged(ws)
    registerAgentSwapBlocker('pty', () => true)
    const exits: number[] = []
    const decision = await applyStagedAssetsIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 3_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })
    expect(decision).toBe('attached')
    expect(exits).toEqual([])
  })

  test('"cannot tell whether a turn is running" still counts as busy', async () => {
    const ws = await workspace()
    await staged(ws)
    const exits: number[] = []
    const decision = await applyStagedAssetsIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 3_000,
      turnInFlight: async () => null,
      exit: (code) => exits.push(code),
    })
    expect(decision).toBe('turn-state-unknown')
    expect(exits).toEqual([])
  })

  test('the rollback latch still wins, even at an idle boundary', async () => {
    const ws = await workspace()
    await staged(ws)
    await Bun.write(ws.agentPinned, '')
    const decision = await applyStagedAssetsIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 3_000,
      turnInFlight: async () => false,
      exit: () => {},
    })
    expect(decision).toBe('pinned')
  })
})

// ---------------------------------------------------------------------------
// OPENCODE HAD NO ROLLBACK AT ALL — the one real hole the other three do not
// have. `publishOpencodeNativeLink` symlink-renames `opencode.current` with NO
// retained predecessor, `pnpm add -g` replaces the global install, and
// `seam.restart()` is `lifecycle.restart()` = a hard stop+start, NOT the
// verified `reloadVerified` the config path uses. So an OpenCode that installed
// cleanly and then failed to serve left the box DOWN, with no previous version
// on disk and no latch to stop the next pass doing it again.
//
// The agent half has all three protections (`agent.prev`, the supervisor's
// failure budget, `agent.pinned`). These give OpenCode the two it can have.
// ---------------------------------------------------------------------------
describe('opencode rollback', () => {
  async function bakeDeps(ws: Awaited<ReturnType<typeof workspace>>, pin: string) {
    await Bun.write(
      join(ws.depsDir, 'package.json'),
      `${JSON.stringify({ name: 'kortix-opencode-config', dependencies: { '@opencode-ai/plugin': pin } }, null, 2)}\n`,
    )
  }

  /** A seam whose restart leaves the runtime in a state the test chooses. */
  function seamWith(states: Array<'ok' | 'down'>, restarts: string[] = []) {
    let index = -1
    return {
      runtime: {
        getInternalUrl: () => 'http://127.0.0.1:4096',
        workspace: () => '/workspace',
        restart: async () => {
          restarts.push('restart')
          index += 1
        },
        getState: () => states[Math.min(Math.max(index, 0), states.length - 1)] ?? 'ok',
      },
    }
  }

  function opencodeWorkspace(ws: Awaited<ReturnType<typeof workspace>>) {
    return {
      installed: ws.opencodeInstalled,
      currentLink: ws.opencodeCurrent,
      prevLink: ws.opencodePrev,
      pinnedPath: ws.opencodePinned,
    }
  }

  test('a restart that never reaches ok re-points current at prev and latches', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    const oc = opencodeWorkspace(ws)
    const restarts: string[] = []
    const installed: string[] = []

    const result = await run(ws, stubFetch(), {
      ...seamWith(['down', 'ok'], restarts),
      opencodeDepsDir: ws.depsDir,
      opencodeCurrentLinkPath: oc.currentLink,
      opencodePrevLinkPath: oc.prevLink,
      opencodePinnedPath: oc.pinnedPath,
      readOpencodeVersion: async () => '1.17.11',
      turnProbe: async () => false,
      installOpencode: async (v: string) => {
        installed.push(v)
      },
      installPluginDeps: async () => {},
    })

    expect(result.opencode).toBe('failed')
    expect(result.reasons?.opencode).toContain('rolled back')
    // Two restarts: the one that failed, and the one onto the previous version.
    expect(restarts).toEqual(['restart', 'restart'])
    // The box is pointed back at the binary it was serving before.
    expect(await readlink(oc.currentLink)).toBe(oc.installed)
    // And it will not try again unaided.
    expect(await stat(oc.pinnedPath).then(() => true, () => false)).toBe(true)
  })

  test('the latch stops the NEXT pass installing anything', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    const oc = opencodeWorkspace(ws)
    await Bun.write(oc.pinnedPath, 'rolled back\n')
    const installed: string[] = []

    const result = await run(ws, stubFetch(), {
      ...seamWith(['ok']),
      opencodeDepsDir: ws.depsDir,
      opencodeCurrentLinkPath: oc.currentLink,
      opencodePrevLinkPath: oc.prevLink,
      opencodePinnedPath: oc.pinnedPath,
      readOpencodeVersion: async () => '1.17.11',
      turnProbe: async () => false,
      installOpencode: async (v: string) => {
        installed.push(v)
      },
    })

    expect(result.opencode).toBe('skipped')
    expect(result.reasons?.opencode).toContain('pinned')
    expect(installed).toEqual([])
  })

  test('a restart that reaches ok records the predecessor and does not latch', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    const oc = opencodeWorkspace(ws)

    const result = await run(ws, stubFetch(), {
      ...seamWith(['ok']),
      opencodeDepsDir: ws.depsDir,
      opencodeCurrentLinkPath: oc.currentLink,
      opencodePrevLinkPath: oc.prevLink,
      opencodePinnedPath: oc.pinnedPath,
      readOpencodeVersion: async () => '1.17.11',
      turnProbe: async () => false,
      installOpencode: async () => {},
      installPluginDeps: async () => {},
    })

    expect(result.opencode).toBe('updated')
    // The predecessor is on disk BEFORE the install, so a rollback has a target.
    expect(await readlink(oc.prevLink)).toBe(oc.installed)
    expect(await stat(oc.pinnedPath).then(() => true, () => false)).toBe(false)
  })

  // "If `opencode.prev` cannot be resolved, do not install — report the reason
  // and leave the box working." A box serving a version we cannot name is a box
  // we cannot put back.
  test('an unresolvable predecessor refuses the install rather than risking the box', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    // opencode IS serving, but the link that names WHICH binary is gone — so
    // there is a running version and no way to point back at it.
    await rm(ws.opencodeCurrent, { force: true })
    const installed: string[] = []

    const result = await run(ws, stubFetch(), {
      ...seamWith(['ok']),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => '1.17.11',
      opencodeBinaryExists: async () => true,
      turnProbe: async () => false,
      installOpencode: async (v: string) => {
        installed.push(v)
      },
    })

    expect(result.opencode).toBe('skipped')
    expect(result.reasons?.opencode).toContain('no rollback target')
    expect(installed).toEqual([])
  })

  // An old snapshot with NO managed binary at all has nothing to roll back to
  // and nothing to lose. It must still be able to repair itself.
  test('a box with no opencode binary installs anyway — there is nothing to protect', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, CLI_BYTES)
    await Bun.write(ws.agentBakedPath, AGENT_BYTES)
    await bakeDeps(ws, '1.17.11')
    const installed: string[] = []

    const result = await run(ws, stubFetch(), {
      ...seamWith(['ok']),
      opencodeDepsDir: ws.depsDir,
      readOpencodeVersion: async () => null,
      opencodeBinaryExists: async () => false,
      turnProbe: async () => false,
      installOpencode: async (v: string) => {
        installed.push(v)
      },
      installPluginDeps: async () => {},
    })

    expect(result.opencode).toBe('updated')
    expect(installed).toEqual(['1.18.19'])
  })
})
