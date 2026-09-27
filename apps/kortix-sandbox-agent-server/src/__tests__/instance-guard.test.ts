import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  abortTargetOf,
  createInstanceGuard,
  loopStartTargetOf,
  noteOpencodeStopRequested,
  opencodeStopRequestedSince,
  resetStopRequestsForTests,
  type InstanceGuard,
} from '../harness/open-code/instance-guard'
import { composeOpenCodeHarnessService } from '../harness/open-code/service'
import { testOpenCodeConfig } from './helpers/open-code-harness'
import { unrequestedAbortCause } from '../harness/open-code/boot'
import type { Opencode } from '../harness/open-code/lifecycle'

// A mock OpenCode that keeps the one behavior this guard exists for, as
// measured on the real opencode 1.18.23 binary (2026-09-25, a project custom
// tool whose import takes 1.5 s):
//
//   - The tool registry is built lazily by its FIRST caller.
//   - A prompt loop that is that first caller and is aborted during the build
//     leaves the registry POISONED: every later loop aborts at once with no
//     parts, and `GET /experimental/tool/ids` answers 503.
//   - A plain GET that starts the build is NOT interrupted when its client
//     goes away; a loop that joins someone else's build only loses its wait.
//   - `POST /instance/dispose` drops the poisoned registry.

const BUILD_MS = 120
const MODEL_MS = 40

type Row = {
  info: {
    id: string
    role: 'user' | 'assistant'
    parentID?: string
    time: { created: number; completed?: number }
    error?: { name: string; data: { message: string } }
  }
  parts: Array<{ type: string; text?: string }>
}

function startMockOpencode() {
  let registry: 'empty' | 'building' | 'ready' | 'poisoned' = 'empty'
  let build: { promise: Promise<void>; owner: 'request' | 'prompt'; cancel: () => void } | null = null
  const sessions = new Map<string, { rows: Row[]; busy: boolean; abort?: () => void }>()
  const stats = { disposes: 0, toolIdCalls: 0, prompts: 0 }
  // Two failure modes of the registry endpoint: held open with no answer, or
  // a single transient 503.
  const modes = { holdToolIds: false, failToolIdsOnce: false }
  let release: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    release = resolve
  })
  let seq = 0
  const id = (prefix: string) => `${prefix}_${String(++seq).padStart(6, '0')}`

  function startBuild(owner: 'request' | 'prompt') {
    registry = 'building'
    let cancel = () => {}
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        registry = 'ready'
        build = null
        resolve()
      }, BUILD_MS)
      cancel = () => {
        clearTimeout(timer)
        registry = 'poisoned'
        build = null
        reject(new Error('interrupted'))
      }
    })
    promise.catch(() => undefined)
    build = { promise, owner, cancel }
    return build
  }

  function session(sid: string) {
    let s = sessions.get(sid)
    if (!s) {
      s = { rows: [], busy: false }
      sessions.set(sid, s)
    }
    return s
  }

  async function runLoop(sid: string, userId: string) {
    const s = session(sid)
    const assistant: Row = {
      info: { id: id('msg'), role: 'assistant', parentID: userId, time: { created: Date.now() } },
      parts: [],
    }
    s.rows.push(assistant)
    s.busy = true
    let aborted = false
    let wake: () => void = () => {}
    const abortSignal = new Promise<void>((resolve) => {
      wake = resolve
    })
    s.abort = () => {
      aborted = true
      wake()
    }
    const end = (ok: boolean) => {
      assistant.info.time.completed = Date.now()
      if (ok) assistant.parts.push({ type: 'text', text: 'OK' })
      else assistant.info.error = { name: 'MessageAbortedError', data: { message: 'Aborted' } }
      s.busy = false
      s.abort = undefined
    }
    if (registry === 'poisoned') {
      await Bun.sleep(5)
      return end(false)
    }
    if (registry === 'empty') {
      const own = startBuild('prompt')
      await Promise.race([own.promise.catch(() => undefined), abortSignal])
      if (aborted) {
        // Still this prompt's build: the Stop interrupts it.
        if (build === own) own.cancel()
        return end(false)
      }
    } else if (registry === 'building' && build) {
      await Promise.race([build.promise.catch(() => undefined), abortSignal])
      if (aborted) return end(false)
    }
    if (registry !== 'ready') return end(false)
    await Promise.race([Bun.sleep(MODEL_MS), abortSignal])
    end(!aborted)
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      if (req.method === 'GET' && path === '/experimental/tool/ids') {
        stats.toolIdCalls += 1
        if (modes.holdToolIds) {
          await stopped
          return new Response('', { status: 503 })
        }
        if (modes.failToolIdsOnce) {
          modes.failToolIdsOnce = false
          return new Response('', { status: 503 })
        }
        if (registry === 'poisoned') return new Response('', { status: 503 })
        if (registry === 'empty') startBuild('request')
        if (build) {
          try {
            await build.promise
          } catch {
            return new Response('', { status: 503 })
          }
        }
        return Response.json(['bash', 'read'])
      }
      if (req.method === 'GET' && ['/agent', '/skill', '/config/providers', '/mcp'].includes(path)) {
        return Response.json({})
      }
      if (req.method === 'POST' && path === '/instance/dispose') {
        stats.disposes += 1
        registry = 'empty'
        build = null
        return Response.json(true)
      }
      if (req.method === 'GET' && path === '/session/status') {
        const out: Record<string, { type: string }> = {}
        for (const [sid, s] of sessions) if (s.busy) out[sid] = { type: 'busy' }
        return Response.json(out)
      }
      const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(path)
      if (req.method === 'POST' && prompt?.[1]) {
        stats.prompts += 1
        const sid = prompt[1]
        const body = (await req.json()) as { parts?: Array<{ text?: string }> }
        const user: Row = {
          info: { id: id('msg'), role: 'user', time: { created: Date.now() } },
          parts: [{ type: 'text', text: body.parts?.[0]?.text ?? '' }],
        }
        session(sid).rows.push(user)
        void runLoop(sid, user.info.id)
        return new Response(null, { status: 204 })
      }
      const abort = /^\/session\/([^/]+)\/abort$/.exec(path)
      if (req.method === 'POST' && abort?.[1]) {
        session(abort[1]).abort?.()
        return Response.json(true)
      }
      const messages = /^\/session\/([^/]+)\/message$/.exec(path)
      if (req.method === 'GET' && messages?.[1]) {
        const rows = session(messages[1]).rows
        const limit = Number(url.searchParams.get('limit') ?? rows.length)
        return Response.json(rows.slice(-limit))
      }
      const bare = /^\/session\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && bare?.[1]) return Response.json({ id: bare[1] })
      return new Response('not found', { status: 404 })
    },
  })

  const base = `http://127.0.0.1:${server.port}`
  return {
    base,
    stats,
    modes,
    registry: () => registry,
    busy: (sid: string) => session(sid).busy,
    lastAssistant: (sid: string) => [...session(sid).rows].reverse().find((r) => r.info.role === 'assistant'),
    async prompt(sid: string, text = 'hi') {
      return fetch(`${base}/session/${sid}/prompt_async?directory=%2Fworkspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      })
    },
    async abort(sid: string) {
      return fetch(`${base}/session/${sid}/abort?directory=%2Fworkspace`, { method: 'POST' })
    },
    stop: () => {
      release()
      server.stop(true)
    },
  }
}

type Mock = ReturnType<typeof startMockOpencode>

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('condition not met in time')
    await Bun.sleep(5)
  }
}

/** Prompt, wait until the loop runs, abort `afterMs` later, wait for the end. */
async function stopDuringTurn(mock: Mock, sid: string, afterMs: number): Promise<void> {
  await mock.prompt(sid)
  await until(() => mock.busy(sid))
  await Bun.sleep(afterMs)
  await mock.abort(sid)
  await until(() => !mock.busy(sid))
}

async function turn(mock: Mock, sid: string): Promise<Row | undefined> {
  await mock.prompt(sid)
  await until(() => mock.busy(sid) || Boolean(mock.lastAssistant(sid)?.info.time.completed))
  await until(() => !mock.busy(sid))
  return mock.lastAssistant(sid)
}

let mock: Mock
let guard: InstanceGuard

beforeEach(() => {
  resetStopRequestsForTests()
  mock = startMockOpencode()
  guard = createInstanceGuard({
    getInternalUrl: () => mock.base,
    workspace: () => '/workspace',
    sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
  })
})

afterEach(() => {
  // Module-level state: clear it on the way OUT too, or the next file in this
  // bun process inherits it (see test-state-reset-tripwire.test.ts).
  resetStopRequestsForTests()
  mock.stop()
})

describe('the poison the guard exists for (mock sanity)', () => {
  test('a Stop while the first prompt builds the registry breaks every later turn', async () => {
    await stopDuringTurn(mock, 'ses_a', 20)
    expect(mock.registry()).toBe('poisoned')
    const next = await turn(mock, 'ses_a')
    expect(next?.info.error?.name).toBe('MessageAbortedError')
    expect(next?.parts).toEqual([])
  })
})

describe('warm', () => {
  test('builds the caches from a request the daemon owns', async () => {
    const result = await guard.warm('boot')
    expect(result?.ok).toBe(true)
    expect(result?.statuses['/experimental/tool/ids']).toBe(200)
    expect(mock.registry()).toBe('ready')
  })

  test('a prompt that arrives during the warm-up and is stopped does not poison the instance', async () => {
    const warming = guard.warm('boot')
    await Bun.sleep(5)
    await stopDuringTurn(mock, 'ses_a', 20)
    await warming
    expect(mock.registry()).toBe('ready')
    const next = await turn(mock, 'ses_a')
    expect(next?.info.error).toBeUndefined()
    expect(next?.parts[0]?.text).toBe('OK')
  })

  test('is single-flight', async () => {
    const [a, b] = await Promise.all([guard.warm('one'), guard.warm('two')])
    expect(a).toBe(b)
    expect(mock.stats.toolIdCalls).toBe(1)
  })

  test('waits for the workspace, then warms on its own', async () => {
    let ready = false
    const gated = createInstanceGuard({
      getInternalUrl: () => mock.base,
      workspace: () => '/workspace',
      canWarm: () => ready,
    })
    expect(await gated.warm('early')).toBeNull()
    expect(mock.stats.toolIdCalls).toBe(0)
    ready = true
    await until(() => mock.registry() === 'ready', 5_000)
  })
})

describe('settled', () => {
  test('resolves when the warm-up ends', async () => {
    const warming = guard.warm('boot')
    await guard.settled(5_000)
    expect(mock.registry()).toBe('ready')
    await warming
  })

  test('is bounded', async () => {
    mock.modes.holdToolIds = true
    void guard.warm('boot')
    const started = Date.now()
    await guard.settled(50)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("a Stop releases its session's held prompt at once, and only that session's", async () => {
    mock.modes.holdToolIds = true
    const hung = guard
    void hung.warm('boot')
    const started = Date.now()
    let releasedA = 0
    let releasedB = 0
    const heldA = hung.settled(5_000, 'ses_a').then(() => (releasedA = Date.now() - started))
    void hung.settled(400, 'ses_b').then(() => (releasedB = Date.now() - started))
    await Bun.sleep(50)
    noteOpencodeStopRequested('ses_a', 'test')
    await heldA
    expect(releasedA).toBeLessThan(300)
    expect(releasedB).toBe(0)
    await Bun.sleep(450)
    expect(releasedB).toBeGreaterThanOrEqual(400)
  })

  test('resolves at once with no warm-up in flight', async () => {
    const started = Date.now()
    await guard.settled(5_000)
    expect(Date.now() - started).toBeLessThan(50)
  })
})

describe('healIfPoisoned', () => {
  test('a clean instance is left alone', async () => {
    await guard.warm('boot')
    const result = await guard.healIfPoisoned('check')
    expect(result).toEqual({ poisoned: false, disposed: false, poisonedPaths: [] })
    expect(mock.stats.disposes).toBe(0)
  })

  test('a poisoned instance is disposed, rebuilt and serves turns again', async () => {
    await stopDuringTurn(mock, 'ses_a', 20)
    expect(mock.registry()).toBe('poisoned')
    const result = await guard.healIfPoisoned('after-stop')
    expect(result.poisoned).toBe(true)
    expect(result.disposed).toBe(true)
    expect(result.poisonedPaths).toEqual(['/experimental/tool/ids'])
    expect(mock.stats.disposes).toBe(1)
    expect(mock.registry()).toBe('ready')
    const next = await turn(mock, 'ses_a')
    expect(next?.parts[0]?.text).toBe('OK')
  })

  test('one 503 is not poison', async () => {
    mock.modes.failToolIdsOnce = true
    const result = await guard.healIfPoisoned('check')
    expect(mock.stats.toolIdCalls).toBeGreaterThanOrEqual(2)
    expect(result.poisoned).toBe(false)
    expect(mock.stats.disposes).toBe(0)
  })

  test('a forced heal never disposes under another busy session', async () => {
    await guard.warm('boot')
    await mock.prompt('ses_other')
    await until(() => mock.busy('ses_other'))
    const result = await guard.healIfPoisoned('forced', { force: true, endingSessionId: 'ses_a' })
    expect(result.disposed).toBe(false)
    expect(mock.stats.disposes).toBe(0)
    await until(() => !mock.busy('ses_other'))
  })
})

describe('inspectEndedTurn', () => {
  test('a completed turn is none', async () => {
    await guard.warm('boot')
    await turn(mock, 'ses_a')
    expect((await guard.inspectEndedTurn('ses_a')).kind).toBe('none')
  })

  test('a requested stop is requested, and the instance it poisoned is healed', async () => {
    await mock.prompt('ses_a')
    await until(() => mock.busy('ses_a'))
    await Bun.sleep(20)
    noteOpencodeStopRequested('ses_a', 'test')
    await mock.abort('ses_a')
    await until(() => !mock.busy('ses_a'))
    const verdict = await guard.inspectEndedTurn('ses_a')
    expect(verdict.kind).toBe('requested')
    if (verdict.kind !== 'requested') throw new Error('unreachable')
    expect(verdict.heal.disposed).toBe(true)
    expect(mock.registry()).toBe('ready')
  })

  test('a victim turn is healed and resumed, once for every observer', async () => {
    // The instance is poisoned by a stop; the NEXT turn aborts on its own.
    await stopDuringTurn(mock, 'ses_a', 20)
    const resumes: string[] = []
    guard.configure({
      isRoot: async () => true,
      resumeVictim: async (sid) => {
        resumes.push(sid)
        return true
      },
    })
    await mock.prompt('ses_a')
    await until(() => Boolean(mock.lastAssistant('ses_a')?.info.parentID) && !mock.busy('ses_a'))
    await Bun.sleep(20)
    const [first, second] = await Promise.all([
      guard.inspectEndedTurn('ses_a'),
      guard.inspectEndedTurn('ses_a'),
    ])
    expect(first.kind).toBe('unrequested')
    if (first.kind !== 'unrequested') throw new Error('unreachable')
    expect(first.resumed).toBe(true)
    expect(first.heal.disposed).toBe(true)
    expect(first.view.empty).toBe(true)
    expect(second).toEqual(first)
    expect(resumes).toEqual(['ses_a'])
    expect(mock.registry()).toBe('ready')
  })

  test('a victim on a clean probe is still disposed: the failed cache may be one no probe reaches', async () => {
    await guard.warm('boot')
    await turn(mock, 'ses_a')
    // Simulate an abort nobody asked for on a healthy registry.
    await mock.prompt('ses_a')
    await until(() => mock.busy('ses_a'))
    await mock.abort('ses_a')
    await until(() => !mock.busy('ses_a'))
    guard.configure({ isRoot: async () => true, resumeVictim: async () => true })
    const verdict = await guard.inspectEndedTurn('ses_a')
    expect(verdict.kind).toBe('unrequested')
    if (verdict.kind !== 'unrequested') throw new Error('unreachable')
    expect(verdict.heal.poisoned).toBe(false)
    expect(verdict.heal.disposed).toBe(true)
    expect(verdict.resumed).toBe(true)
  })

  test('a child session is healed but never resumed', async () => {
    await stopDuringTurn(mock, 'ses_child', 20)
    await turn(mock, 'ses_child')
    let resumed = false
    guard.configure({
      isRoot: async () => false,
      resumeVictim: async () => {
        resumed = true
        return true
      },
    })
    const verdict = await guard.inspectEndedTurn('ses_child')
    expect(verdict.kind).toBe('unrequested')
    if (verdict.kind !== 'unrequested') throw new Error('unreachable')
    expect(verdict.resumed).toBe(false)
    expect(verdict.heal.disposed).toBe(true)
    expect(resumed).toBe(false)
  })

  test('an unrequested abort after the model answered is not a victim', async () => {
    await guard.warm('boot')
    await mock.prompt('ses_a')
    await until(() => mock.busy('ses_a'))
    await Bun.sleep(MODEL_MS + 30)
    await until(() => !mock.busy('ses_a'))
    // Rewrite the answered turn into an abort that kept its output.
    const last = mock.lastAssistant('ses_a')
    if (!last) throw new Error('no assistant')
    last.info.error = { name: 'MessageAbortedError', data: { message: 'Aborted' } }
    let resumed = false
    guard.configure({ isRoot: async () => true, resumeVictim: async () => (resumed = true) })
    const verdict = await guard.inspectEndedTurn('ses_a')
    expect(verdict.kind).toBe('unrequested')
    if (verdict.kind !== 'unrequested') throw new Error('unreachable')
    expect(verdict.view.empty).toBe(false)
    expect(verdict.heal.disposed).toBe(false)
    expect(resumed).toBe(false)
  })
})

describe('stop requests', () => {
  test('are recorded per session on the daemon clock', () => {
    noteOpencodeStopRequested('ses_a', 'test', 1_000)
    expect(opencodeStopRequestedSince('ses_a', 999)).toBe(true)
    expect(opencodeStopRequestedSince('ses_a', 1_000)).toBe(true)
    expect(opencodeStopRequestedSince('ses_a', 1_001)).toBe(false)
    expect(opencodeStopRequestedSince('ses_b', 0)).toBe(false)
  })

  test('route shapes', () => {
    expect(abortTargetOf('POST', '/session/ses_1/abort')).toBe('ses_1')
    expect(abortTargetOf('post', '/session/ses_1/abort?directory=%2Fworkspace')).toBe('ses_1')
    expect(abortTargetOf('GET', '/session/ses_1/abort')).toBeNull()
    expect(abortTargetOf('POST', '/session/ses_1/message')).toBeNull()
    expect(loopStartTargetOf('POST', '/session/ses_1/prompt_async')).toBe('ses_1')
    expect(loopStartTargetOf('POST', '/session/ses_1/message')).toBe('ses_1')
    expect(loopStartTargetOf('POST', '/session/ses_1/command')).toBe('ses_1')
    expect(loopStartTargetOf('POST', '/session/ses_1/shell')).toBe('ses_1')
    expect(loopStartTargetOf('GET', '/session/ses_1/message')).toBeNull()
    expect(loopStartTargetOf('POST', '/session/ses_1/abort')).toBeNull()
  })
})

// Through the production composition: the proxy and the guard are the ones
// composeOpenCodeHarnessService wires together, over a lifecycle that points
// at the mock.
describe('proxy', () => {
  const composed = () =>
    composeOpenCodeHarnessService(testOpenCodeConfig(), {
      getInternalUrl: () => mock.base,
      getState: () => 'ok',
      getPid: () => null,
    } as unknown as Opencode)

  test('a proxied abort is recorded as a requested stop before OpenCode sees it', async () => {
    const { proxy } = composed()
    const before = Date.now()
    await proxy.forward({ method: 'POST', path: '/session/ses_a/abort', search: '', headers: new Headers() })
    expect(opencodeStopRequestedSince('ses_a', before)).toBe(true)
  })

  test('a prompt waits for the warm-up, so it can never be the first caller of a cache', async () => {
    const { proxy, instanceGuard } = composed()
    const warming = instanceGuard.warm('boot')
    const res = await proxy.forward({
      method: 'POST',
      path: '/session/ses_a/prompt_async',
      search: '?directory=%2Fworkspace',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new Response(JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] })).body,
    })
    expect(res.status).toBe(204)
    // The registry was ready before the prompt reached OpenCode.
    expect(mock.registry()).toBe('ready')
    await warming
    await until(() => !mock.busy('ses_a'))
    // A Stop now cannot poison: the build is done.
    await stopDuringTurn(mock, 'ses_a', 5)
    expect(mock.registry()).toBe('ready')
  })
})

describe('unrequestedAbortCause', () => {
  const view = { assistantMessageId: 'msg_1', turnStartedAtMs: 1, errorName: 'MessageAbortedError', empty: true }
  const heal = { poisoned: true, disposed: true, poisonedPaths: ['/experimental/tool/ids'] }

  test('names a victim that could not be resumed', () => {
    const cause = unrequestedAbortCause({ kind: 'unrequested', heal, view, resumed: false })
    expect(cause?.name).toBe('RuntimeAbortedTurn')
    expect(cause?.message).toContain('Kortix reset the runtime')
  })

  test('says nothing for a resumed turn, a requested stop, or an abort that kept output', () => {
    expect(unrequestedAbortCause({ kind: 'unrequested', heal, view, resumed: true })).toBeUndefined()
    expect(unrequestedAbortCause({ kind: 'requested', heal })).toBeUndefined()
    expect(unrequestedAbortCause({ kind: 'none' })).toBeUndefined()
    expect(
      unrequestedAbortCause({ kind: 'unrequested', heal, view: { ...view, empty: false }, resumed: false }),
    ).toBeUndefined()
  })
})
