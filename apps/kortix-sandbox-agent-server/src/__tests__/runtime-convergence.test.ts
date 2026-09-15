import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_SWAP_EXIT_CODE,
  reconcileRuntimeAssets,
  refreshOpencodePluginPin,
  registerAgentSwapBlocker,
  requestAgentSwapIfIdle,
  resetAgentSwapBlockersForTests,
  resetRuntimeConvergenceForTests,
  noteRuntimeConvergence,
  runtimeConvergenceReport,
  resetRuntimeConvergenceReportForTests,
  overlayHash,
} from '../runtime-assets'

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
  return {
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
  }
}

afterEach(async () => {
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
  extra: Record<string, unknown> = {},
) {
  return reconcileRuntimeAssets({
    apiUrl: API_URL,
    token: TOKEN,
    cliPath: ws.cliPath,
    managedSkillsDir: ws.skillsDir,
    statePath: ws.statePath,
    agentStateDir: ws.stateDir,
    agentBakedPath: ws.agentBakedPath,
    fetchImpl: stub.impl,
    ...extra,
  })
}

/** A seam whose opencode is reachable and idle unless a test says otherwise. */
function opencodeSeam(restarts: string[] = []) {
  return {
    seam: {
      opencodeBaseUrl: () => 'http://127.0.0.1:4096',
      workspace: '/workspace',
      restartOpencode: async () => {
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

  test('refreshOpencodePluginPin reports an absent dependency dir instead of failing', async () => {
    const ws = await workspace()
    expect(await refreshOpencodePluginPin(ws.depsDir, '1.18.19')).toBe('absent')
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

  test('never exits across a live turn', async () => {
    const ws = await workspace()
    await stage(ws)
    const exits: number[] = []

    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => true,
      exit: (code) => exits.push(code),
    })

    expect(decision).toBe('turn-in-flight')
    expect(exits).toEqual([])
  })

  test('unreadable turn state counts as busy', async () => {
    const ws = await workspace()
    await stage(ws)
    const exits: number[] = []

    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => null,
      exit: (code) => exits.push(code),
    })

    expect(decision).toBe('turn-state-unknown')
    expect(exits).toEqual([])
  })

  test('a registered blocker (an open PTY) defers the swap', async () => {
    const ws = await workspace()
    await stage(ws)
    const exits: number[] = []
    registerAgentSwapBlocker('pty', () => true)

    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })

    expect(decision).toBe('attached')
    expect(exits).toEqual([])
  })

  test('a blocker that throws counts as busy', async () => {
    const ws = await workspace()
    await stage(ws)
    const exits: number[] = []
    registerAgentSwapBlocker('pty', () => {
      throw new Error('registry unavailable')
    })

    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })

    expect(decision).toBe('attached')
    expect(exits).toEqual([])
  })

  test('nothing staged → nothing requested', async () => {
    const ws = await workspace()
    const exits: number[] = []

    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })

    expect(decision).toBe('nothing-staged')
    expect(exits).toEqual([])
  })

  test('a digest side-car without its binary is not a staged update', async () => {
    const ws = await workspace()
    await Bun.write(ws.agentNextSha, `${sha(AGENT_BYTES)}\n`)
    const exits: number[] = []

    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })

    expect(decision).toBe('nothing-staged')
    expect(exits).toEqual([])
  })

  test('a pinned box does not ask for a restart it would waste', async () => {
    const ws = await workspace()
    await stage(ws)
    await Bun.write(ws.agentPinned, '')
    const exits: number[] = []

    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })

    expect(decision).toBe('pinned')
    expect(exits).toEqual([])
  })

  test('an unconfigured daemon never exits on its own', async () => {
    const ws = await workspace()
    await stage(ws)

    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 10 * 60_000,
    })

    expect(decision).toBe('not-configured')
  })

  test('a freshly booted daemon never restarts itself on the session-start path', async () => {
    const ws = await workspace()
    await stage(ws)
    const exits: number[] = []

    // The boot reconcile fires seconds after opencode is ready — the moment a
    // user sends their first prompt and the frontend polls readiness. The
    // supervisor promotes before every launch anyway, so waiting costs nothing.
    const decision = await requestAgentSwapIfIdle({
      agentStateDir: ws.stateDir,
      uptimeMs: 20_000,
      turnInFlight: async () => false,
      exit: (code) => exits.push(code),
    })

    expect(decision).toBe('too-young')
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

  test('starts empty — a box that has never reconciled must not look converged', async () => {
    const report = await runtimeConvergenceReport(mkdtempSync(join(tmpdir(), 'rcr-')))
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
    const report = await runtimeConvergenceReport(mkdtempSync(join(tmpdir(), 'rcr-')))
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
    const report = await runtimeConvergenceReport(mkdtempSync(join(tmpdir(), 'rcr-')))
    expect(report.components).toEqual({ cli: 'current', skills: 'current' })
    expect(report.build).toBeNull()
  })

  test('reads the rollback latch from DISK, not from the last pass', async () => {
    // The SUPERVISOR writes agent.pinned between daemon runs, so a value cached
    // at reconcile time is stale exactly when someone is looking: the first
    // health check after a rollback.
    const dir = mkdtempSync(join(tmpdir(), 'rcr-'))
    noteRuntimeConvergence({ cli: 'current', skills: 'current', build: 7 })
    expect((await runtimeConvergenceReport(dir)).pinned).toBe(false)
    writeFileSync(join(dir, 'agent.pinned'), '')
    expect((await runtimeConvergenceReport(dir)).pinned).toBe(true)
  })
})
