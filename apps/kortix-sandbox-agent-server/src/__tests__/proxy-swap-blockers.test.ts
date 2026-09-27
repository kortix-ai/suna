/**
 * DEF-B/DEF-D 2026-09-26 — `startProxy` must register a swap blocker for an
 * in-flight config convergence, the same way it already registers `pty`,
 * `runtime-starting` and `sse-subscriber` (proxy.ts:240-258), and the `pty`
 * blocker must use the abandoned-pty bound rather than a bare status check.
 *
 * The config-convergence mechanism itself — a registered blocker actually
 * defers `requestAgentSwapIfIdle` while `convergeConfigRelease`'s `inFlight`
 * is set — is proven end to end against the real convergence pipeline in
 * `config-release-converge.test.ts`, "the agent swap is blocked while a
 * config convergence is in flight". What THAT test cannot see is whether
 * `startProxy` is the thing that wires it in for a real daemon boot. This
 * file drives `startProxy` itself with a fake `HarnessService` (the same
 * technique `harness-boundary.test.ts` uses to prove host code depends only
 * on the contract) and reads the decision back through the real,
 * module-level `requestAgentSwapIfIdle` — so it is a behavior assertion, not
 * a source-text one.
 *
 * `harness.control.convergenceInFlight` — not a direct import of
 * `harness/open-code/config-release` — is deliberate: `proxy.ts` is host
 * production code, and importing a concrete adapter from there is exactly
 * what `harness-boundary.test.ts`'s "only the resolver can import a concrete
 * adapter" tripwire forbids.
 */
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import type { HarnessService } from '../harness/harness'
import type { HarnessQueryService } from '../harness/queries'
import { requireOpenCodeConfig } from '../harness/open-code/config'
import { startProxy } from '../proxy'
import {
  requestAgentSwapIfIdle,
  resetAgentSwapBlockersForTests,
  type AgentSwapDecision,
} from '../runtime-assets'
import { ptyIsAbandoned, PTY_ABANDONED_AFTER_MS } from '../routes/pty'

const TEST_TOKEN = 'test-kortix-token-32-chars-1234567890'

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    servicePort: 0,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3213,
    workspace: '/tmp',
    projectTarget: '/tmp',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    compiledBootMode: 'off',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
    ...over,
  }
}

const unexpected = (): never => { throw new Error('unused operation must not run') }

/** The minimal `HarnessService` `startProxy` needs, with a controllable convergence flag. */
function fakeHarness(convergenceInFlight: () => boolean): HarnessService {
  const queries: HarnessQueryService = {
    readState: unexpected, readMessages: unexpected, readVcsDiff: unexpected,
    readCurrentProject: unexpected, readConfiguration: unexpected,
    readSession: unexpected, readTodo: unexpected, pinnedSessionId: unexpected,
    replyPermission: unexpected, replyQuestion: unexpected, rejectQuestion: unexpected,
    stopSession: unexpected, revertSession: unexpected, unrevertSession: unexpected,
    observeTurn: unexpected,
    events: { epoch: 'test', headSeq: 0, firstSeq: 0, subscribe: unexpected },
    attachments: { read: unexpected },
  }
  return {
    id: 'test-only-adapter',
    environment: { home: '/tmp' },
    lifecycle: { start: async () => {}, stop: async () => {}, restart: async () => {}, getState: () => 'ok' },
    proxy: {
      blockedPorts: () => [],
      readiness: async () => ({ ready: true }),
      forward: unexpected,
    },
    control: {
      convergenceInFlight,
      bind: () => ({
        applyEnvironment: unexpected, refresh: unexpected, abort: unexpected,
        armAbortAfterTool: unexpected, disarmAbortAfterTool: unexpected,
      }),
    },
    diagnostics: { health: unexpected, report: unexpected, logSources: () => [], readLog: unexpected },
    queries: { bind: () => queries },
    background: { start: () => ({ stop: () => {} }) as unknown as ReturnType<HarnessService['background']['start']> },
    assets: {
      componentNames: [], resolveConfigDir: async () => '/tmp', injectSkills: async () => {},
      reconcile: async () => ({ components: {}, reasons: {}, state: {} }),
    },
  }
}

let proxy: ReturnType<typeof startProxy> | undefined
const dirs: string[] = []

afterEach(async () => {
  await proxy?.stop()
  proxy = undefined
  resetAgentSwapBlockersForTests()
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true })
})

async function stagedAgentStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-swap-blockers-'))
  dirs.push(dir)
  const bytes = 'candidate bytes'
  await Bun.write(join(dir, 'agent.next'), bytes)
  await Bun.write(join(dir, 'agent.next.sha256'), `${createHash('sha256').update(bytes).digest('hex')}\n`)
  return dir
}

test('a convergence the fake harness reports in flight defers the swap', async () => {
  const cfg = baseConfig()
  proxy = startProxy(cfg, fakeHarness(() => true), Date.now())

  const decision: AgentSwapDecision = await requestAgentSwapIfIdle({
    agentStateDir: await stagedAgentStateDir(),
    uptimeMs: 10 * 60_000,
    turnInFlight: async () => false,
    exit: () => { throw new Error('must not exit while a convergence is in flight') },
  })
  expect(decision).toBe('attached')
})

test('a convergence the fake harness reports IDLE lets the swap proceed', async () => {
  const cfg = baseConfig()
  proxy = startProxy(cfg, fakeHarness(() => false), Date.now())
  const exits: number[] = []

  const decision = await requestAgentSwapIfIdle({
    agentStateDir: await stagedAgentStateDir(),
    uptimeMs: 10 * 60_000,
    turnInFlight: async () => false,
    exit: (code) => exits.push(code),
  })
  expect(decision).toBe('exited')
  expect(exits).toEqual([75])
})

test('convergenceInFlight() absent on the harness never blocks (a runtime with no such concept)', async () => {
  const harness = fakeHarness(() => false)
  // Simulate an adapter that never implements the optional method at all.
  delete (harness.control as { convergenceInFlight?: unknown }).convergenceInFlight
  const cfg = baseConfig()
  proxy = startProxy(cfg, harness, Date.now())
  const exits: number[] = []

  const decision = await requestAgentSwapIfIdle({
    agentStateDir: await stagedAgentStateDir(),
    uptimeMs: 10 * 60_000,
    turnInFlight: async () => false,
    exit: (code) => exits.push(code),
  })
  expect(decision).toBe('exited')
  expect(exits).toEqual([75])
})

test('the pty blocker uses the abandoned-pty bound, not a bare status check', () => {
  // DEF-D: a running pty with no attached viewer, silent past the bound, must
  // not count as live work. Exercised directly against the real predicate
  // `proxy.ts` calls (its own import is asserted by type — `ptyIsAbandoned`
  // and `PTY_ABANDONED_AFTER_MS` come from `routes/pty.ts`, the module that
  // owns the registry, not a bare `status === 'running'` check re-derived
  // in proxy.ts).
  const abandoned = {
    id: 'a', title: 't', command: 'bash', args: [], cwd: '/', status: 'running' as const,
    pid: 1, attachedViewers: 0, idleMs: PTY_ABANDONED_AFTER_MS + 1,
  }
  const live = { ...abandoned, id: 'b', idleMs: 0 }
  expect(ptyIsAbandoned(abandoned)).toBe(true)
  expect(ptyIsAbandoned(live)).toBe(false)
})
