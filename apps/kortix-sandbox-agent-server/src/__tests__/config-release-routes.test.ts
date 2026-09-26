/**
 * `/kortix/config/converge`, `/kortix/config/workspace`, and the
 * `/kortix/refresh?config_dir=1` alias.
 *
 * The converge route is a trigger. It never reads the request body: the daemon
 * fetches the descriptor from the API, so a caller cannot choose the config.
 * The end-to-end case drives the real OpenCode control service against a fake
 * API with a real repository and a real archive.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pointBootLink, readBootLinkTarget } from '../boot-config'
import type { Config } from '../config'
import type { HarnessConfigConvergeResult, HarnessControlOperations } from '../harness/control'
import { createOpenCodeQuickQueueInterrupt } from '../harness/open-code/background'
import { ConvergeBusyError, resetConfigReleaseStateForTests } from '../harness/open-code/config-release'
import { MAX_SWAP_DELAY_MS } from '../harness/control'
import { createOpenCodeControlService } from '../harness/open-code/control'
import type { Opencode, VerifiedReloadResult } from '../harness/open-code/lifecycle'
import { createConfigRouter } from '../routes/config'
import { createRefreshRouter } from '../routes/refresh'
import {
  buildRelease,
  commitAll,
  git,
  initRepo,
  serveRelease,
  startFakeApi,
  write,
  type FakeApi,
} from './helpers/config-release-fixtures'

const TOKEN = 'sandbox-token'
const cfgWithToken = { sandboxToken: TOKEN } as Config
const bearer = { Authorization: `Bearer ${TOKEN}` }

const converged: HarnessConfigConvergeResult = {
  ok: true,
  outcome: 'unchanged',
  config: {
    release_id: 'a'.repeat(64),
    desired_release_id: 'a'.repeat(64),
    source: 'release',
    mode: 'follow-base',
    proven: true,
    fallback_reason: null,
    failed_release_id: null,
  },
  reload: null,
  reason: null,
}

function fakeControl(over: Partial<HarnessControlOperations> = {}) {
  const calls = { converge: [] as unknown[][], refresh: 0 }
  const control: HarnessControlOperations = {
    applyEnvironment: async () => {
      throw new Error('unexpected env')
    },
    refresh: async () => {
      calls.refresh++
      return { ok: true, repo: {} as never, opencode: 'ok', opencode_pid: 1 }
    },
    abort: async () => {
      throw new Error('unexpected abort')
    },
    armAbortAfterTool: async () => undefined,
    disarmAbortAfterTool: () => undefined,
    convergeConfig: async (...args: unknown[]) => {
      calls.converge.push(args)
      return converged
    },
    ...over,
  }
  return { control, calls }
}

describe('config routes with a fake control', () => {
  test('converge requires the sandbox bearer', async () => {
    const { control, calls } = fakeControl()
    const router = createConfigRouter(cfgWithToken, control)
    expect((await router.request('/converge', { method: 'POST' })).status).toBe(401)
    expect((await router.request('/converge', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect(calls.converge).toHaveLength(0)
    const unconfigured = createConfigRouter({} as Config, control)
    expect((await unconfigured.request('/converge', { method: 'POST', headers: bearer })).status).toBe(503)
  })

  test('converge passes nothing from the request body to the control', async () => {
    const { control, calls } = fakeControl()
    const router = createConfigRouter(cfgWithToken, control)
    const res = await router.request('/converge', {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'config-release-v1', release_id: 'e'.repeat(64), archive: { url: 'https://evil' } }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(converged)
    // The only thing the route reads off the request is the fault-injection
    // delay, and it is absent here.
    expect(calls.converge).toEqual([[{ delayBeforeSwapMs: undefined }]])
  })

  /**
   * `?delay_before_swap_ms` — fault injection, the same shape as `verify_fail`
   * on `POST /kortix/refresh`. It holds a convergence between the turn gate and
   * the swap, so a test can land a prompt inside the window DEF-DEV-1 lived in
   * instead of racing it.
   */
  test('the fault-injection delay is read, bounded, and never negative', async () => {
    const cases: Array<[string, number | undefined]> = [
      ['250', 250],
      // Bounded: a caller cannot park a convergence for an hour.
      [String(MAX_SWAP_DELAY_MS * 10), MAX_SWAP_DELAY_MS],
      ['0', undefined],
      ['-5', undefined],
      ['nonsense', undefined],
    ];
    for (const [raw, expected] of cases) {
      const { control, calls } = fakeControl()
      const res = await createConfigRouter(cfgWithToken, control).request(
        `/converge?delay_before_swap_ms=${encodeURIComponent(raw)}`,
        { method: 'POST', headers: bearer },
      )
      expect(res.status).toBe(200)
      expect(calls.converge).toEqual([[{ delayBeforeSwapMs: expected }]])
    }
  })

  test('the refresh alias carries the delay too', async () => {
    const { control, calls } = fakeControl()
    const res = await createRefreshRouter(cfgWithToken, control).request(
      '/?config_dir=1&delay_before_swap_ms=300',
      { method: 'POST', headers: bearer },
    )
    expect(res.status).toBe(200)
    expect(calls.converge).toEqual([[{ delayBeforeSwapMs: 300 }]])
  })

  test('a convergence already running answers 409', async () => {
    const { control } = fakeControl({
      convergeConfig: async () => {
        throw new ConvergeBusyError()
      },
    })
    const res = await createConfigRouter(cfgWithToken, control).request('/converge', { method: 'POST', headers: bearer })
    expect(res.status).toBe(409)
  })

  test('the workspace-report route is gone: the descriptor request has no inputs', async () => {
    const { control } = fakeControl()
    const res = await createConfigRouter(cfgWithToken, control).request('/workspace', { headers: bearer })
    expect(res.status).toBe(404)
  })

  test('refresh?config_dir=1 is an alias of converge; the plain refresh does not run', async () => {
    const { control, calls } = fakeControl()
    const res = await createRefreshRouter(cfgWithToken, control).request(
      '/?config_dir=1&reload_if_synced=1&restart=0&repo=0',
      { method: 'POST', headers: bearer },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(converged)
    expect(calls.converge).toHaveLength(1)
    expect(calls.refresh).toBe(0)
  })

  test('a runtime without config releases: converge is 404, config_dir=1 keeps the plain refresh', async () => {
    const { control, calls } = fakeControl({ convergeConfig: undefined })
    expect(
      (await createConfigRouter(cfgWithToken, control).request('/converge', { method: 'POST', headers: bearer })).status,
    ).toBe(404)
    const res = await createRefreshRouter(cfgWithToken, control).request('/?config_dir=1', {
      method: 'POST',
      headers: bearer,
    })
    expect(res.status).toBe(200)
    expect(calls.refresh).toBe(1)
  })
})

describe('POST /kortix/config/converge end to end through the OpenCode control service', () => {
  let root: string
  let api: FakeApi
  const saved: Record<string, string | undefined> = {}
  const ENV = ['KORTIX_BOOT_CONFIG_ROOT', 'KORTIX_MANAGED_SKILLS_DIR', 'KORTIX_SESSION_ID', 'KORTIX_COMPILED_AGENT_CONFIG', 'KORTIX_COMPILED_AGENT_CONFIG_ETAG']

  beforeEach(() => {
    resetConfigReleaseStateForTests()
    for (const name of ENV) saved[name] = process.env[name]
    root = mkdtempSync(join(tmpdir(), 'kortix-config-route-'))
    api = startFakeApi(TOKEN)
  })

  afterEach(() => {
    api.stop()
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    spawnSync('chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
  })

  test('a descriptor in the request body is ignored; the API descriptor is applied', async () => {
    const origin = join(root, 'origin')
    const work = join(root, 'work')
    const store = join(root, 'store')
    const overlay = join(root, 'overlay')
    const defaultDir = join(root, 'default')
    mkdirSync(overlay, { recursive: true })
    mkdirSync(defaultDir, { recursive: true })
    writeFileSync(join(defaultDir, 'opencode.jsonc'), '{}')
    initRepo(origin)
    write(origin, '.kortix/opencode/opencode.jsonc', '{}\n')
    write(origin, '.kortix/opencode/agents/kortix.md', 'FROM THE API\n')
    const commit = commitAll(origin, 'base')
    git(root, 'clone', '--quiet', `file://${origin}`, work)
    const release = buildRelease(origin, commit, '.kortix/opencode', { governance: '{"agent":{}}' })
    serveRelease(api, release)
    process.env.KORTIX_BOOT_CONFIG_ROOT = store
    process.env.KORTIX_MANAGED_SKILLS_DIR = overlay
    process.env.KORTIX_SESSION_ID = 'ses-1'

    // A booted box always has its boot link pointed; what OpenCode reads is
    // read back from the link, never from a second copy of the answer.
    await pointBootLink(join(work, '.kortix/opencode'), store)
    const opencode = {
      getPid: () => 7,
      getState: () => 'ok',
      // The route path now hands `convergeConfigRelease` a turn probe
      // (control.ts), and the probe needs a base url. No session is pinned in
      // this test, which `opencodeTurnInFlight` answers as a definite `false`.
      getInternalUrl: () => 'http://127.0.0.1:4096',
      async reloadVerified(): Promise<VerifiedReloadResult> {
        return { outcome: 'swapped', port: 4097, pid: 8, turnEnded: false, orphanedMessageId: null }
      },
    } as unknown as Opencode
    const cfg = {
      sandboxToken: TOKEN,
      apiUrl: api.url,
      projectId: 'proj-1',
      projectTarget: work,
      workspace: work,
      defaultBranch: 'main',
      defaultOpencodeConfigDir: defaultDir,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
    } as unknown as Config
    const control = createOpenCodeControlService(opencode, createOpenCodeQuickQueueInterrupt(opencode, cfg as never)).bind({ cfg })

    const res = await createConfigRouter(cfg, control).request('/converge', {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...release.descriptor,
        release_id: 'e'.repeat(64),
        archive: { url: '/v1/projects/proj-1/config-archives/deadbeef', bytes: 10 },
        files: [['agents/kortix.md', '100644', 'f'.repeat(40)]],
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as HarnessConfigConvergeResult
    expect(body.outcome).toBe('applied')
    expect(body.config.release_id).toBe(release.descriptor.release_id)
    expect(api.descriptorRequests).toHaveLength(1)
    expect(api.archiveRequests.map((request) => request.path)).toEqual([release.descriptor.archive!.url])
    const serving = (await readBootLinkTarget(store))!
    expect(readFileSync(join(serving, 'agents/kortix.md'), 'utf8')).toBe('FROM THE API\n')
    expect(serving).toBe(join(store, release.descriptor.release_id!))
    expect(git(work, 'status', '--porcelain')).toBe('')
  })
})
