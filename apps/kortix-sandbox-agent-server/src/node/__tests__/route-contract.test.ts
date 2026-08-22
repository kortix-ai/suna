/**
 * GOLDEN CHARACTERIZATION OF THE DAEMON'S HTTP CONTRACT.
 *
 * WHY THIS EXISTS. On 2026-07-30 a multi-harness refactor was rolled back in a
 * single day because it "did not add a parallel ACP path, it rewrote shared
 * REST code" (`8953c09b2c`). Three client regressions survived with the feature
 * flag off, and nothing caught them, because nothing had written down what the
 * shipped path actually did.
 *
 * This file writes it down. It is captured BEFORE any file moves in the kortixd
 * refactor (docs/specs/2026-08-21-kortixd.md §12) and it must stay green
 * through every phase. If a rename or an extraction changes a status code, an
 * auth outcome, or the shape of a response body, this fails and names the route.
 *
 * WHAT IT ASSERTS, and deliberately not more:
 *   - the status code for every mounted surface, authenticated and not
 *   - WHICH routes require `X-Kortix-User-Context` — the security contract, and
 *     the thing a careless extraction is most likely to quietly widen
 *   - the KEY SET of every JSON body, never the values
 *
 * Values are excluded on purpose. `uptime_s`, `opencode_pid`, timestamps and
 * ports are volatile; asserting them would make this suite flaky and it would
 * get deleted, which is worse than not having it. The key set is what clients
 * bind to.
 *
 * WHAT THIS DOES NOT COVER, stated so nobody mistakes it for the whole net:
 *   - `fakeOpencode()` points at a dead port, so every proxied route is recorded
 *     as a 502 error shape. This golden pins the daemon's MOUNTING and AUTH
 *     BOUNDARY; it says nothing about the behaviour of the reverse-proxied
 *     OpenCode path — which is the exact code the July refactor rewrote.
 *   - Values are excluded, so `/kortix/health` is pinned as 21 key names only.
 *   - Spec §12 rule 2 asks for four artifacts: health, boot timeline, route
 *     table, and a full turn transcript from a real dev session. This is the
 *     route table. The turn transcript needs a live sandbox and does not exist
 *     yet; until it does, no static suite can claim P1-P4 preserve turn
 *     behaviour.
 *
 * TO UPDATE after an INTENTIONAL contract change:
 *   KORTIX_UPDATE_GOLDEN=1 bun test src/node/__tests__/route-contract.test.ts
 * then review the diff in golden/route-contract.json as carefully as you would
 * review the code change. An unexplained line in that diff is a regression.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Config } from '../../config'
import type { Opencode } from '../../opencode'
import { buildOpencodeApp } from '../../proxy'
import { createProjectEnvStore } from '../../project-env'
import { KORTIX_USER_CONTEXT_HEADER } from '../../kortix-user-context'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = resolve(HERE, 'golden/route-contract.json')
const UPDATING = process.env.KORTIX_UPDATE_GOLDEN === '1'

const TEST_TOKEN = 'route-contract-golden-token'
let WORKSPACE: string

function baseConfig(): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace: WORKSPACE,
    projectTarget: WORKSPACE,
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: 'project-golden',
    apiUrl: 'http://api.invalid/v1',
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
  } as Config
}

/**
 * opencode reporting healthy on a dead port. Any route that proxies gets a
 * connection failure rather than a 503 — which is itself part of the contract
 * being captured, and it keeps the suite hermetic (no child process).
 */
function fakeOpencode(): Opencode {
  return {
    getState: () => 'ok',
    getPid: () => 4242,
    getActivePort: () => 4096,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
    reconfigure: () => {},
    start: async () => {},
  } as unknown as Opencode
}

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signContext(): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(
    JSON.stringify({
      userId: 'user-golden',
      sandboxId: 'sandbox-golden',
      sandboxRole: 'owner',
      scopes: [],
      iat: now,
      exp: now + 3600,
    }),
  )
  const sig = createHmac('sha256', TEST_TOKEN)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${payload}.${sig}`
}

interface Probe {
  readonly method: string
  readonly path: string
  /** Present only when the route needs a body to reach its handler. */
  readonly body?: unknown
}

/**
 * Every mounted surface. Grouped as the proxy mounts them so a reader can see
 * the auth boundary: `/kortix/*` bypasses the gate, everything else does not.
 */
const PROBES: readonly Probe[] = [
  // /kortix/* — the control surface, deliberately outside the HMAC gate
  { method: 'GET', path: '/kortix/health' },
  { method: 'GET', path: '/kortix/health/' },
  { method: 'POST', path: '/kortix/refresh', body: {} },
  { method: 'POST', path: '/kortix/abort', body: {} },
  { method: 'GET', path: '/kortix/pty' },
  { method: 'GET', path: '/kortix/git' },
  // The highest-privilege route on the box: it writes environment into the live
  // process and the agent env file, gated by a bearer token rather than by the
  // HMAC middleware (routes/env.ts).
  { method: 'GET', path: '/kortix/env' },
  { method: 'POST', path: '/kortix/env', body: {} },
  // BARE `/kortix`, no trailing slash. The auth gate skips only paths starting
  // with `/kortix/` WITH the slash, while `app.route('/kortix', …)` maps the
  // bare path INTO the router. It therefore sits on the boundary the test below
  // asserts, and was not probed when that assertion was first written.
  { method: 'GET', path: '/kortix' },
  { method: 'POST', path: '/kortix', body: {} },

  // Daemon-owned, behind the HMAC gate
  { method: 'GET', path: '/file?path=/' },
  { method: 'GET', path: '/file/content?path=/nope.txt' },
  { method: 'GET', path: '/file/raw?path=/nope.txt' },
  { method: 'GET', path: '/file/status' },
  { method: 'POST', path: '/file/mkdir', body: { path: '/golden-probe-dir' } },
  { method: 'GET', path: '/find?q=nothing' },
  { method: 'GET', path: '/find/file?q=nothing' },

  // Port + web proxies
  { method: 'GET', path: '/proxy/8000/' },
  { method: 'GET', path: '/web-proxy/http/127.0.0.1:8000/' },

  // Reverse-proxy catch-all → opencode
  { method: 'GET', path: '/global/health' },
  { method: 'GET', path: '/session' },
]

type Observation = {
  status: number
  /** Sorted top-level keys of a JSON body. `null` when the body is not JSON. */
  keys: string[] | null
}

type RouteRecord = {
  unauthenticated: Observation
  authenticated: Observation
}

async function observe(base: string, probe: Probe, headers: Record<string, string>): Promise<Observation> {
  const init: RequestInit = { method: probe.method, headers: { ...headers } }
  if (probe.body !== undefined) {
    init.body = JSON.stringify(probe.body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  let res: Response
  try {
    res = await fetch(`${base}${probe.path}`, init)
  } catch {
    // A transport-level failure is a stable, meaningful observation for the
    // proxy routes pointed at a dead port.
    return { status: 0, keys: null }
  }
  let keys: string[] | null = null
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const parsed = await res.json()
      keys =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? Object.keys(parsed as Record<string, unknown>).sort()
          : []
    } catch {
      keys = null
    }
  } else {
    await res.arrayBuffer().catch(() => undefined)
  }
  return { status: res.status, keys }
}

describe('daemon route contract (golden)', () => {
  let server: ReturnType<typeof Bun.serve>
  let base: string
  let observed: Record<string, RouteRecord>

  beforeAll(async () => {
    WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-route-golden-'))
    // projectEnv is REQUIRED to reproduce production. proxy.ts mounts the env
    // router only `if (envRouter)`, and envRouter is null without a store — so
    // the first version of this golden was recorded from an app that did not
    // contain POST /kortix/env at all, the highest-privilege route on the box
    // (it writes arbitrary environment into the live process and the agent env
    // file). All three production call sites pass one.
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode(),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
      createProjectEnvStore({}),
    )
    server = Bun.serve({ port: 0, fetch: app.fetch })
    base = `http://127.0.0.1:${server.port}`

    observed = {}
    for (const probe of PROBES) {
      const key = `${probe.method} ${probe.path}`
      observed[key] = {
        unauthenticated: await observe(base, probe, {}),
        authenticated: await observe(base, probe, {
          [KORTIX_USER_CONTEXT_HEADER]: signContext(),
        }),
      }
    }

    if (UPDATING) {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true })
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(observed, null, 2)}\n`)
    }
  })

  afterAll(async () => {
    server?.stop(true)
    if (WORKSPACE) await fs.rm(WORKSPACE, { recursive: true, force: true })
  })

  test('matches the recorded contract', () => {
    expect(
      existsSync(GOLDEN_PATH),
      `No golden file. Capture it with:\n  KORTIX_UPDATE_GOLDEN=1 bun test src/node/__tests__/route-contract.test.ts`,
    ).toBe(true)
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, RouteRecord>
    expect(observed).toEqual(golden)
  })

  test('no PROBED non-/kortix route answers an unsigned request', () => {
    // NAMED for what it can prove. An earlier version was called "the /kortix/*
    // prefix is the only surface outside the HMAC gate" — an invariant about
    // ALL routes, asserted by a loop over a fixed probe list, in the same commit
    // that moved the bare `/kortix` path across that very boundary. A probe list
    // can only speak for what it probes; keep the name honest and keep PROBES
    // exhaustive.
    const gatedButUnauthenticatedOk: string[] = []
    for (const [key, record] of Object.entries(observed)) {
      const routePath = key.slice(key.indexOf(' ') + 1)
      // The control namespace is `/kortix` AND `/kortix/*`. Both are handled by
      // the kortix router, which is mounted BEFORE the gate middleware — Hono
      // runs handlers in registration order, so the router answers first and the
      // gate never sees the request.
      //
      // Bare `/kortix` used to fall through the router (it had no terminating
      // handler) and reach the gate, which answered 401. It now answers 404 from
      // the terminator. Capability unauthenticated: none before, none after; what
      // changed is that an AUTHENTICATED `/kortix` no longer proxies into
      // opencode. Recorded in the golden rather than hidden here.
      if (routePath === '/kortix' || routePath.startsWith('/kortix/')) continue
      // 401 is the gate rejecting. Anything else means the request reached a
      // handler without a signed context.
      if (record.unauthenticated.status !== 401) gatedButUnauthenticatedOk.push(key)
    }
    expect(
      gatedButUnauthenticatedOk,
      'These routes answered an UNSIGNED request with something other than 401. Either the auth gate moved, or a route was mounted outside it.',
    ).toEqual([])
  })

  test('health answers without a signed context and always reports daemon ok', async () => {
    // The control plane polls this mid-boot, before any context exists. It is
    // the one route that must never require auth and must never 5xx.
    const res = await fetch(`${base}/kortix/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.daemon).toBe('ok')
  })

  test('an unmatched /kortix path never reaches opencode unauthenticated', async () => {
    // REGRESSION GUARD. `/kortix/*` is deliberately outside the HMAC gate, and
    // the reverse-proxy catch-all sits after it. Before the terminating handler
    // in proxy.ts, an unmatched control path fell between the two: measured
    // `GET /kortix/zzz` -> 200 with the upstream receiving "/kortix/zzz", no
    // signed context anywhere. Not exploitable then (opencode serves nothing
    // under the prefix) but a gate with a bypass surface is a defect.
    //
    // Asserted against a REAL upstream that records what it was asked for, so
    // this proves "did not forward" rather than merely "did not 200".
    const seen: string[] = []
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(new URL(req.url).pathname)
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
    })
    const opencode = {
      getState: () => 'ok',
      getPid: () => 1,
      getActivePort: () => upstream.port,
      getInternalUrl: () => `http://127.0.0.1:${upstream.port}`,
      restart: async () => {},
      reconfigure: () => {},
      start: async () => {},
    } as unknown as Opencode
    const guarded = Bun.serve({
      port: 0,
      fetch: buildOpencodeApp(baseConfig(), opencode, Date.now()).fetch,
    })
    try {
      for (const probe of ['/kortix/zzz', '/kortix/session', '/kortix/git', '/kortix/env']) {
        const res = await fetch(`http://127.0.0.1:${guarded.port}${probe}`)
        expect(res.status, `${probe} should 404 at the control router`).toBe(404)
      }
      expect(seen, 'no unmatched /kortix path may reach opencode').toEqual([])
    } finally {
      guarded.stop(true)
      upstream.stop(true)
    }
  })

  test('health never leaks a credential', async () => {
    // /kortix/health is unauthenticated. Assert no declared secret VALUE ever
    // appears in its body — the cheapest possible guard against a future field
    // echoing config into an open route.
    const res = await fetch(`${base}/kortix/health`)
    const text = await res.text()
    expect(text.includes(TEST_TOKEN)).toBe(false)
  })
})
