/**
 * cloudSpawnSession (RFC Pillar 1 keystone) against a fake fetch and a fake
 * clock. Covers: the create body (prompt, agent choice, inline instructions,
 * tool narrowing, depth), the parent link via the bearer, onSession with the
 * real child id, poll-to-idle, the final-report read-back, the depth gate, the
 * live-child cap, abort → stop, and task_id resume as a follow-up prompt.
 * Also routeSubagent: the per-call `session` choice, its default, the
 * fallback when separate is off or has no control plane, and task_id resume
 * per mode. No real time, no network.
 */
import { describe, expect, test } from 'bun:test'
import {
  childToolAllowlist,
  cloudSpawnSession,
  cloudSubagentApiFrom,
  NO_CONTROL_PLANE_NOTICE,
  routeSubagent,
  SEPARATE_OFF_NOTICE,
  subagentContextFrom,
  type CloudSubagentApi,
} from '@/harness/pi/cloud-subagent'

const PARENT = '00000000-0000-4000-8000-000000000001'

function api(fetchImpl: typeof fetch, over: Partial<CloudSubagentApi> = {}): CloudSubagentApi {
  return {
    apiUrl: 'https://api.example.com/v1',
    projectId: 'proj-1',
    token: 'sess-token',
    sessionId: PARENT,
    parentAgent: 'builder',
    depth: 0,
    maxDepth: 2,
    maxLive: 4,
    live: { count: 0 },
    fetchImpl,
    ...over,
  }
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: any }

/**
 * A fake API: POST /sessions answers `create`; GET /sessions/:id answers the
 * next row of `rows`; GET …/transcript answers `transcript`; POST …/prompts
 * and …/stop answer 202.
 */
function fakeApi(opts: {
  create?: { status: number; body: unknown }
  rows?: unknown[]
  transcript?: { status: number; body: unknown }
}) {
  const calls: Call[] = []
  let rowIdx = 0
  const rows = opts.rows ?? []
  const impl = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
    calls.push({ url, method, headers, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) })
    const path = new URL(url).pathname
    if (method === 'POST' && path.endsWith('/sessions')) {
      const create = opts.create ?? { status: 201, body: { session_id: 'child-1' } }
      return new Response(JSON.stringify(create.body), { status: create.status })
    }
    if (method === 'POST') return new Response('{}', { status: 202 })
    if (path.endsWith('/transcript')) {
      const t = opts.transcript ?? { status: 200, body: { messages: [] } }
      return new Response(JSON.stringify(t.body), { status: t.status })
    }
    const row = rows[Math.min(rowIdx++, rows.length - 1)]
    return new Response(JSON.stringify(row), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const fast = { pollIntervalMs: 0, now: () => 0 }
const WORKING = { status: 'running', working: { state: 'working', pending_delivery: false } }
const IDLE = { status: 'running', working: { state: 'idle', since: '2026-10-24T10:00:00.000Z', pending_delivery: false } }
const report = (text: string) => ({ status: 200, body: { messages: [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'step' }, { role: 'assistant', text }] } })

describe('cloudSpawnSession — create', () => {
  test('a named agent: the child runs as it, linked via the bearer, and its final report is the result', async () => {
    const { impl, calls } = fakeApi({ rows: [WORKING, IDLE], transcript: report('Found 3 issues in the diff.') })
    const seen: unknown[] = []
    const result = await cloudSpawnSession(
      api(impl),
      { title: 'Check it', agent: 'reviewer', systemPrompt: 'the reviewer prompt', prompt: 'review the diff', onSession: (s) => seen.push(s) },
      fast,
    )
    expect(result).toEqual({ sessionId: 'child-1', status: 'completed', text: 'Found 3 issues in the diff.', model: { providerID: 'kortix', modelID: 'default' } })
    expect(seen).toEqual([{ sessionId: 'child-1', model: { providerID: 'kortix', modelID: 'default' } }])
    const create = calls.find((c) => c.method === 'POST')!
    expect(create.url).toBe('https://api.example.com/v1/projects/proj-1/sessions')
    expect(create.headers.authorization).toBe('Bearer sess-token')
    expect(create.body).toEqual({
      initial_prompt: 'review the diff',
      name: 'Check it',
      agent_name: 'reviewer',
      runtime_context: { 'kortix.subagent.depth': 1 },
    })
    const read = calls.find((c) => c.url.includes('/transcript'))!
    expect(read.url).toBe('https://api.example.com/v1/projects/proj-1/sessions/child-1/transcript?limit=20&detail=full')
    expect(read.headers.authorization).toBe('Bearer sess-token')
  })

  test('a built-in runs as the PARENT agent and carries its prompt as initial_context', async () => {
    const { impl, calls } = fakeApi({ rows: [IDLE], transcript: report('done') })
    await cloudSpawnSession(api(impl), { title: 'x', agent: 'general', systemPrompt: '  You are a subagent.  ', prompt: 'go' }, fast)
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ agent_name: 'builder', initial_context: 'You are a subagent.' })
  })

  test('the platform coordinator sends no agent_name (the API picks the project default)', async () => {
    // runtime.ts `cloudParent` leaves `parentAgent` out for the coordinator.
    const coordinator = cloudSubagentApiFrom({ apiUrl: 'https://a/v1', projectId: 'p', sandboxToken: 't' })!
    const { impl, calls } = fakeApi({ rows: [IDLE], transcript: report('done') })
    await cloudSpawnSession({ ...coordinator, fetchImpl: impl }, { title: 'x', agent: 'inline', systemPrompt: 'Be brief.', prompt: 'go' }, fast)
    expect(calls.find((c) => c.method === 'POST')!.body).not.toHaveProperty('agent_name')
  })

  test('an inline spec: instructions, model and its tools inside the parent narrowing', async () => {
    const { impl, calls } = fakeApi({ rows: [IDLE], transcript: report('done') })
    const result = await cloudSpawnSession(
      api(impl, { depth: 1, toolAllowlist: ['read', 'grep', 'bash'] }),
      { title: 'x', agent: 'inline', systemPrompt: 'You audit logs.', model: 'kortix/fast', tools: ['read', 'write', 'grep'], prompt: 'go' },
      fast,
    )
    expect(result.model).toEqual({ providerID: 'kortix', modelID: 'fast' })
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      agent_name: 'builder',
      model: 'kortix/fast',
      initial_context: 'You audit logs.',
      // `write` is dropped: the parent itself may not use it.
      runtime_context: { 'kortix.subagent.depth': 2, 'kortix.subagent.tools': 'read,grep' },
    })
  })

  test('a turn that started and ended between two polls still settles (idle with a new `since`)', async () => {
    const { impl } = fakeApi({ rows: [IDLE], transcript: report('quick') })
    const result = await cloudSpawnSession(api(impl), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast)
    expect(result).toMatchObject({ status: 'completed', text: 'quick' })
  })

  test('idle with no ended turn yet does not settle; the ceiling ends the wait and stops the child', async () => {
    let t = 0
    const { impl, calls } = fakeApi({ rows: [{ status: 'running', working: { state: 'idle', since: null } }] })
    const parent = api(impl)
    const result = await cloudSpawnSession(parent, { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, {
      pollIntervalMs: 0,
      waitCeilingMs: 60_000,
      now: () => (t += 10_000),
    })
    expect(result).toMatchObject({
      sessionId: 'child-1',
      status: 'error',
      error: 'child session did not settle within 1 min; the child session was stopped',
    })
    // The slot is freed only because the child no longer runs.
    expect(calls.some((c) => c.method === 'POST' && c.url === 'https://api.example.com/v1/projects/proj-1/sessions/child-1/stop')).toBe(true)
    expect(parent.live.count).toBe(0)
  })

  test('a failed child session returns error', async () => {
    const { impl } = fakeApi({ rows: [{ status: 'failed', working: { state: 'idle' } }] })
    const result = await cloudSpawnSession(api(impl), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast)
    expect(result).toMatchObject({ sessionId: 'child-1', status: 'error', error: 'child session failed' })
  })

  test('a non-2xx create returns error, not a child', async () => {
    const { impl } = fakeApi({ create: { status: 403, body: { error: 'nope' } } })
    const result = await cloudSpawnSession(api(impl), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast)
    expect(result.status).toBe('error')
    expect(result.error).toContain('403')
  })

  test('read-back: a last turn that failed with no text is an error; an unreadable transcript is a pointer', async () => {
    const failed = fakeApi({ rows: [IDLE], transcript: { status: 200, body: { messages: [{ role: 'assistant', text: '', error: { name: 'APIError', data: { message: 'model overloaded' } } }] } } })
    expect(await cloudSpawnSession(api(failed.impl), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast)).toMatchObject({
      status: 'error',
      error: "the subagent's last turn failed: model overloaded",
    })
    const unreadable = fakeApi({ rows: [IDLE], transcript: { status: 503, body: {} } })
    const result = await cloudSpawnSession(api(unreadable.impl), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast)
    expect(result.status).toBe('completed')
    expect(result.text).toContain('child session child-1')
    expect(result.text).toContain('503')
  })

  test('read-back: text earlier in the turn, then a failed last message, is an error, not a report', async () => {
    const { impl } = fakeApi({
      rows: [IDLE],
      transcript: { status: 200, body: { messages: [{ role: 'user', text: 'go' }, { role: 'assistant', text: "I'll start with the logs." }, { role: 'assistant', text: '', error: 'model exploded' }] } },
    })
    expect(await cloudSpawnSession(api(impl), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast)).toMatchObject({
      status: 'error',
      error: "the subagent's last turn failed: model exploded",
    })
  })

  test('a named agent is narrowed to the parent agent tools too (the create body carries the parent list)', async () => {
    const { impl, calls } = fakeApi({ rows: [IDLE], transcript: report('done') })
    await cloudSpawnSession(api(impl, { toolAllowlist: ['read', 'grep'] }), { title: 'x', agent: 'builder', systemPrompt: 'build', prompt: 'go' }, fast)
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      initial_prompt: 'go',
      name: 'x',
      agent_name: 'builder',
      runtime_context: { 'kortix.subagent.depth': 1, 'kortix.subagent.tools': 'read,grep' },
    })
  })

  test('inline instructions over the API cap are refused before any session exists', async () => {
    const { impl, calls } = fakeApi({})
    await expect(
      cloudSpawnSession(api(impl), { title: 'x', agent: 'inline', systemPrompt: 'x'.repeat(8_193), prompt: 'go' }, fast),
    ).rejects.toThrow('at most 8192')
    expect(calls).toEqual([])
  })
})

describe('cloudSpawnSession — guardrails', () => {
  test('a session at the max depth starts no cloud child', async () => {
    const { impl, calls } = fakeApi({})
    await expect(
      cloudSpawnSession(api(impl, { depth: 2, maxDepth: 2 }), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast),
    ).rejects.toThrow('nest at most 2 levels and this session is level 2. Pass session: "same"')
    expect(calls).toEqual([])
  })

  test('the live-child cap refuses a call past it, counting parallel calls, and frees the slot after', async () => {
    const { impl } = fakeApi({ rows: [WORKING, IDLE], transcript: report('done') })
    const parent = api(impl, { maxLive: 1 })
    const first = cloudSpawnSession(parent, { title: 'a', agent: 'general', systemPrompt: '', prompt: 'go' }, fast)
    await expect(cloudSpawnSession(parent, { title: 'b', agent: 'general', systemPrompt: '', prompt: 'go' }, fast)).rejects.toThrow(
      'At most 1 separate subagent sessions run at once for one session, and 1 are running. Wait for one to return, or pass session: "same"',
    )
    expect((await first).status).toBe('completed')
    expect(parent.live.count).toBe(0)
  })

  test('an aborted call stops its child', async () => {
    const { impl, calls } = fakeApi({ rows: [WORKING] })
    const abort = new AbortController()
    const result = await cloudSpawnSession(
      api(impl),
      { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go', signal: abort.signal, onSession: () => abort.abort() },
      fast,
    )
    expect(result).toMatchObject({ sessionId: 'child-1', status: 'aborted' })
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/sessions/child-1/stop'))).toBe(true)
  })
})

describe('cloudSpawnSession — task_id resume', () => {
  const OWN_IDLE = { session_id: 'child-7', parent_session_id: PARENT, status: 'running', working: { state: 'idle', since: '2026-10-24T09:00:00.000Z' } }

  test('sends a follow-up prompt to the existing child and returns its new report', async () => {
    const { impl, calls } = fakeApi({ rows: [OWN_IDLE, OWN_IDLE, IDLE], transcript: report('follow-up done') })
    const result = await cloudSpawnSession(api(impl), { sessionId: 'child-7', title: 'x', agent: 'general', systemPrompt: '', prompt: 'and the tests?' }, fast)
    expect(result).toMatchObject({ sessionId: 'child-7', status: 'completed', text: 'follow-up done' })
    const prompt = calls.find((c) => c.method === 'POST')!
    expect(prompt.url).toBe('https://api.example.com/v1/projects/proj-1/sessions/child-7/prompts')
    expect(prompt.body.parts).toEqual([{ type: 'text', text: 'and the tests?' }])
    expect(typeof prompt.body.client_message_id).toBe('string')
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/sessions'))).toBe(false)
  })

  test('a follow-up turn that fails returns error, never the previous turn report', async () => {
    const { impl } = fakeApi({
      rows: [OWN_IDLE, OWN_IDLE, IDLE],
      transcript: {
        status: 200,
        body: { messages: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'OLD-REPORT' }, { role: 'user', text: 'again' }, { role: 'assistant', text: '', error: 'model exploded' }] },
      },
    })
    const result = await cloudSpawnSession(api(impl), { sessionId: 'child-7', title: 'x', agent: 'general', systemPrompt: '', prompt: 'again' }, fast)
    expect(result).toMatchObject({ sessionId: 'child-7', status: 'error', error: "the subagent's last turn failed: model exploded" })
    expect(result.text).toBe('')
  })

  test('a follow-up turn with no text returns the pointer, never the previous turn report', async () => {
    const { impl } = fakeApi({
      rows: [OWN_IDLE, OWN_IDLE, IDLE],
      transcript: { status: 200, body: { messages: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'OLD-REPORT' }, { role: 'user', text: 'again' }, { role: 'assistant', text: '' }] } },
    })
    const result = await cloudSpawnSession(api(impl), { sessionId: 'child-7', title: 'x', agent: 'general', systemPrompt: '', prompt: 'again' }, fast)
    expect(result.status).toBe('completed')
    expect(result.text).not.toContain('OLD-REPORT')
    expect(result.text).toContain('finished without a text report')
  })

  test('a task_id that is not a child of this session is refused', async () => {
    const other = fakeApi({ rows: [{ ...OWN_IDLE, parent_session_id: 'someone-else' }] })
    await expect(
      cloudSpawnSession(api(other.impl), { sessionId: 'child-7', title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast),
    ).rejects.toThrow('not a subagent session of this session')
    expect(other.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  test('a running child is refused', async () => {
    const { impl } = fakeApi({ rows: [{ ...OWN_IDLE, working: { state: 'working' } }] })
    await expect(
      cloudSpawnSession(api(impl), { sessionId: 'child-7', title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast),
    ).rejects.toThrow('already running')
  })
})

describe('subagent context and target', () => {
  test('subagentContextFrom reads depth and tools; garbage is a root session', () => {
    expect(subagentContextFrom(undefined)).toEqual({ depth: 0 })
    expect(subagentContextFrom('not json')).toEqual({ depth: 0 })
    expect(subagentContextFrom(JSON.stringify({ 'kortix.subagent.depth': 2 }))).toEqual({ depth: 2 })
    expect(subagentContextFrom(JSON.stringify({ 'kortix.subagent.depth': 1, 'kortix.subagent.tools': 'read, grep,bad name' }))).toEqual({
      depth: 1,
      tools: ['read', 'grep'],
    })
    // A present but empty list narrows to nothing, never to everything.
    expect(subagentContextFrom(JSON.stringify({ 'kortix.subagent.tools': '' }))).toEqual({ depth: 0, tools: [] })
  })

  test('childToolAllowlist only ever narrows', () => {
    expect(childToolAllowlist(undefined, undefined)).toBeUndefined()
    expect(childToolAllowlist(undefined, ['read'])).toEqual(['read'])
    expect(childToolAllowlist(['read', 'grep'], undefined)).toEqual(['read', 'grep'])
    expect(childToolAllowlist(['read'], ['read', 'bash'])).toEqual(['read'])
  })

  test('cloudSubagentApiFrom is null without a control plane, and carries the session, depth and limits', () => {
    expect(cloudSubagentApiFrom({ apiUrl: 'https://a', projectId: 'p' })).toBeNull()
    expect(
      cloudSubagentApiFrom({ apiUrl: 'https://a', projectId: 'p', sandboxToken: 't', sessionId: PARENT, context: { depth: 1, tools: ['read'] }, maxLive: 2, maxDepth: 3 }),
    ).toEqual({ apiUrl: 'https://a', projectId: 'p', token: 't', sessionId: PARENT, depth: 1, maxDepth: 3, maxLive: 2, toolAllowlist: ['read'], live: { count: 0 } })
    expect(cloudSubagentApiFrom({ apiUrl: 'https://a', projectId: 'p', sandboxToken: 't' })).toMatchObject({ depth: 0, maxDepth: 2, maxLive: 4 })
  })
})

describe('routeSubagent — where one agent call runs', () => {
  const ready = { localChild: false, separateAllowed: true, controlPlane: true }

  test('a call with no session runs in a separate session', () => {
    expect(routeSubagent({ ...ready })).toEqual({ session: 'separate' })
    expect(routeSubagent({ ...ready, requested: 'separate' })).toEqual({ session: 'separate' })
  })

  test('session "same" runs in this session, with no notice', () => {
    expect(routeSubagent({ ...ready, requested: 'same' })).toEqual({ session: 'same' })
  })

  test('separate with the project setting off runs in this session and says why', () => {
    expect(routeSubagent({ ...ready, separateAllowed: false })).toEqual({ session: 'same', notice: SEPARATE_OFF_NOTICE })
    expect(routeSubagent({ ...ready, requested: 'separate', separateAllowed: false })).toEqual({ session: 'same', notice: SEPARATE_OFF_NOTICE })
  })

  test('separate with no control plane runs in this session and says why', () => {
    expect(routeSubagent({ ...ready, controlPlane: false })).toEqual({ session: 'same', notice: NO_CONTROL_PLANE_NOTICE })
  })

  test('a task_id resumes the child in the mode it was created in, whatever the call asks', () => {
    expect(routeSubagent({ ...ready, taskId: 'ses_local', localChild: true })).toEqual({ session: 'same' })
    expect(routeSubagent({ ...ready, taskId: 'ses_local', localChild: true, requested: 'separate' })).toEqual({ session: 'same' })
    expect(routeSubagent({ ...ready, taskId: 'child-7', requested: 'same' })).toEqual({ session: 'separate' })
  })
})
