/**
 * cloudSpawnSession (RFC Pillar 1 keystone) against a fake fetch and a fake
 * clock. Covers: the create body (prompt, agent choice, inline instructions,
 * tool narrowing, depth), the parent link via the bearer, onSession with the
 * real child id, poll-to-idle, the final-report read-back, the depth gate, the
 * live-child cap, abort → stop, and task_id resume as a follow-up prompt.
 * Also routeSubagent: the per-call `session` choice, its default, the
 * fallback when separate is off or has no control plane, and task_id resume
 * per mode. Background (`run_in_background`): the create body asks the API to
 * notify the parent, the call returns once the child exists, a resume of a
 * background child does not wait, and the live cap counts background children
 * the API lists as working. Names, teammates and forks: the create body's
 * metadata and runtime context, a name clash among live children, and
 * `task_stop` by id and by name (`cloudStopChild`). No real time, no network.
 */
import { describe, expect, test } from 'bun:test'
import {
  childToolAllowlist,
  cloudSpawnSession,
  cloudStopChild,
  cloudSubagentApiFrom,
  FOREGROUND_NOTICE,
  NO_CONTROL_PLANE_NOTICE,
  routeSubagent,
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
 * A fake API: POST /sessions answers `create`; GET /sessions (the child list)
 * answers `children`; GET /sessions/:id answers the next row of `rows`; GET
 * …/transcript answers `transcript`; POST …/prompts and …/stop answer 202.
 */
function fakeApi(opts: {
  create?: { status: number; body: unknown }
  children?: unknown[]
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
    if (path.endsWith('/sessions')) return new Response(JSON.stringify(opts.children ?? []), { status: 200 })
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
      'At most 1 separate subagent sessions run at once for one session, and 1 are running. Wait for one to finish, or pass session: "same"',
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

describe('cloudSpawnSession — background', () => {
  const BG = { notify_parent: true }

  test('a background call asks the API to notify the parent and returns once the child exists', async () => {
    const { impl, calls } = fakeApi({})
    const seen: unknown[] = []
    const parent = api(impl)
    const result = await cloudSpawnSession(
      parent,
      { title: 'Audit', agent: 'reviewer', systemPrompt: 'p', prompt: 'audit the logs', background: true, onSession: (s) => seen.push(s) },
      fast,
    )
    expect(result).toEqual({ sessionId: 'child-1', status: 'started', text: '', model: { providerID: 'kortix', modelID: 'default' } })
    expect(seen).toEqual([{ sessionId: 'child-1', model: { providerID: 'kortix', modelID: 'default' } }])
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      initial_prompt: 'audit the logs',
      name: 'Audit',
      agent_name: 'reviewer',
      metadata: { notify_parent: true },
      runtime_context: { 'kortix.subagent.depth': 1 },
    })
    // No wait, no read-back: only the child list (the cap) and the create.
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /v1/projects/proj-1/sessions', 'POST /v1/projects/proj-1/sessions'])
    expect(parent.live.count).toBe(0)
  })

  test('the live cap counts background children the API lists as working, and only those', async () => {
    const working = [
      { status: 'provisioning', metadata: BG },
      { status: 'running', metadata: BG, working: { state: 'working' } },
      // Not counted: finished, stopped, or a foreground child (this box counts those itself).
      { status: 'running', metadata: BG, working: { state: 'idle' } },
      { status: 'stopped', metadata: BG },
      { status: 'running', metadata: {}, working: { state: 'working' } },
    ]
    const full = fakeApi({ children: working })
    const parent = api(full.impl, { maxLive: 2 })
    await expect(cloudSpawnSession(parent, { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go', background: true }, fast)).rejects.toThrow(
      'At most 2 separate subagent sessions run at once for one session, and 2 are running.',
    )
    expect(full.calls.some((c) => c.method === 'POST')).toBe(false)
    expect(parent.live.count).toBe(0)

    const room = fakeApi({ children: working.slice(1) })
    expect((await cloudSpawnSession(api(room.impl, { maxLive: 2 }), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go', background: true }, fast)).status).toBe('started')
  })

  test('a blocking call counts the working background children too', async () => {
    const { impl, calls } = fakeApi({ children: [{ status: 'provisioning', metadata: BG }] })
    await expect(cloudSpawnSession(api(impl, { maxLive: 1 }), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fast)).rejects.toThrow('and 1 are running')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  test('a task_id resume of a background child sends the follow-up and does not wait', async () => {
    const own = { session_id: 'child-7', parent_session_id: PARENT, status: 'stopped', metadata: BG, working: { state: 'idle', since: '2026-10-24T09:00:00.000Z' } }
    const { impl, calls } = fakeApi({ rows: [own] })
    const result = await cloudSpawnSession(api(impl), { sessionId: 'child-7', title: 'x', agent: 'general', systemPrompt: '', prompt: 'now the tests' }, fast)
    expect(result).toMatchObject({ sessionId: 'child-7', status: 'started' })
    expect(calls.find((c) => c.method === 'POST')!.url).toBe('https://api.example.com/v1/projects/proj-1/sessions/child-7/prompts')
    expect(calls.some((c) => c.url.includes('/transcript'))).toBe(false)
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
  const ready = { localChild: false, controlPlane: true }

  test('a call with no session runs in a separate session', () => {
    expect(routeSubagent({ ...ready })).toEqual({ session: 'separate' })
    expect(routeSubagent({ ...ready, requested: 'separate' })).toEqual({ session: 'separate' })
  })

  test('session "same" runs in this session, with no notice', () => {
    expect(routeSubagent({ ...ready, requested: 'same' })).toEqual({ session: 'same' })
  })

  test('separate with no control plane runs in this session and says why', () => {
    expect(routeSubagent({ ...ready, controlPlane: false })).toEqual({ session: 'same', notice: NO_CONTROL_PLANE_NOTICE })
  })

  test('run_in_background runs only in a separate session; elsewhere it waits and says why', () => {
    expect(routeSubagent({ ...ready, background: true })).toEqual({ session: 'separate' })
    expect(routeSubagent({ ...ready, background: true, requested: 'same' })).toEqual({ session: 'same', notice: FOREGROUND_NOTICE })
    expect(routeSubagent({ ...ready, background: true, controlPlane: false })).toEqual({
      session: 'same',
      notice: `${NO_CONTROL_PLANE_NOTICE} ${FOREGROUND_NOTICE}`,
    })
  })

  test('a task_id resumes the child in the mode it was created in, whatever the call asks', () => {
    expect(routeSubagent({ ...ready, taskId: 'ses_local', localChild: true })).toEqual({ session: 'same' })
    expect(routeSubagent({ ...ready, taskId: 'ses_local', localChild: true, requested: 'separate' })).toEqual({ session: 'same' })
    expect(routeSubagent({ ...ready, taskId: 'child-7', requested: 'same' })).toEqual({ session: 'separate' })
  })
})

describe('cloudSpawnSession — names, teammates, forks', () => {
  test('a name rides in metadata agent_handle and in the runtime context', async () => {
    const { impl, calls } = fakeApi({})
    await cloudSpawnSession(api(impl), { title: 'Review', agent: 'reviewer', systemPrompt: 'p', prompt: 'review it', background: true, handle: 'reviewer' }, fast)
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      initial_prompt: 'review it',
      name: 'Review',
      agent_name: 'reviewer',
      metadata: { notify_parent: true, agent_handle: 'reviewer' },
      runtime_context: { 'kortix.subagent.depth': 1, 'kortix.agent.handle': 'reviewer' },
    })
  })

  test('a name a live child holds refuses the call and names that child; an ended child frees it', async () => {
    const holder = { session_id: 'child-9', name: 'Review the API', status: 'running', metadata: { agent_handle: 'Reviewer' }, working: { state: 'idle' } }
    const taken = fakeApi({ children: [holder] })
    await expect(cloudSpawnSession(api(taken.impl), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go', background: true, handle: 'reviewer' }, fast)).rejects.toThrow(
      'The name "reviewer" is taken: your subagent child-9 (Review the API) still runs under it. Message it with send_message({ to: "reviewer" }), stop it with task_stop({ name: "reviewer" }), or pick another name.',
    )
    expect(taken.calls.some((c) => c.method === 'POST')).toBe(false)
    const free = fakeApi({ children: [{ ...holder, status: 'stopped' }] })
    expect((await cloudSpawnSession(api(free.impl), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go', background: true, handle: 'reviewer' }, fast)).status).toBe('started')
  })

  test('a name outside the handle form is refused before any call', async () => {
    const { impl, calls } = fakeApi({})
    await expect(cloudSpawnSession(api(impl), { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go', handle: 'two words' }, fast)).rejects.toThrow('"two words" is not a name for a subagent')
    expect(calls).toHaveLength(0)
  })

  test('a teammate: metadata team_lead, always notify_parent, its instructions in initial_context, and it returns at once', async () => {
    const { impl, calls } = fakeApi({})
    const result = await cloudSpawnSession(
      api(impl),
      { title: 'Research', agent: 'reviewer', systemPrompt: 'p', prompt: 'research it', teammate: { lead: PARENT, handle: 'researcher', instructions: 'You are a teammate.' } },
      fast,
    )
    expect(result.status).toBe('started')
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      initial_prompt: 'research it',
      name: 'Research',
      agent_name: 'reviewer',
      initial_context: 'You are a teammate.',
      metadata: { notify_parent: true, agent_handle: 'researcher', team_lead: PARENT },
      runtime_context: { 'kortix.subagent.depth': 1, 'kortix.agent.handle': 'researcher', 'kortix.team.lead': PARENT },
    })
  })

  test('a fork names this session as fork_from_session_id and runs as the parent agent', async () => {
    const { impl, calls } = fakeApi({})
    await cloudSpawnSession(api(impl), { title: 'Try B (fork)', agent: 'inline', systemPrompt: 'You are a fork.', prompt: 'try B', background: true, fork: true }, fast)
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      initial_prompt: 'try B',
      name: 'Try B (fork)',
      agent_name: 'builder',
      initial_context: 'You are a fork.',
      metadata: { notify_parent: true },
      fork_from_session_id: PARENT,
      runtime_context: { 'kortix.subagent.depth': 1 },
    })
  })

  test('subagentContextFrom reads the handle and the team lead', () => {
    expect(subagentContextFrom(JSON.stringify({ 'kortix.subagent.depth': 1, 'kortix.agent.handle': 'researcher', 'kortix.team.lead': PARENT }))).toEqual({ depth: 1, handle: 'researcher', teamLead: PARENT })
    expect(subagentContextFrom(JSON.stringify({ 'kortix.subagent.depth': 1, 'kortix.agent.handle': 'no spaces allowed' }))).toEqual({ depth: 1 })
  })
})

describe('cloudStopChild — task_stop', () => {
  test('by name: the live child with that handle is stopped', async () => {
    const children = [
      { session_id: 'child-1', name: 'Old', status: 'stopped', metadata: { agent_handle: 'reviewer' } },
      { session_id: 'child-2', name: 'Review', status: 'running', metadata: { agent_handle: 'reviewer' } },
    ]
    const { impl, calls } = fakeApi({ children })
    expect(await cloudStopChild(api(impl), { name: '@reviewer' })).toEqual({ sessionId: 'child-2', handle: 'reviewer', title: 'Review', stopped: true })
    expect(calls.filter((c) => c.method === 'POST').map((c) => new URL(c.url).pathname)).toEqual(['/v1/projects/proj-1/sessions/child-2/stop'])
  })

  test('by id: only a child of this session; one that already ended is not stopped again', async () => {
    const ended = fakeApi({ rows: [{ session_id: 'child-3', parent_session_id: PARENT, status: 'completed', metadata: {} }] })
    expect(await cloudStopChild(api(ended.impl), { taskId: 'child-3' })).toEqual({ sessionId: 'child-3', handle: null, title: null, stopped: false })
    expect(ended.calls.some((c) => c.method === 'POST')).toBe(false)
    const foreign = fakeApi({ rows: [{ session_id: 'child-4', parent_session_id: 'someone-else', status: 'running' }] })
    await expect(cloudStopChild(api(foreign.impl), { taskId: 'child-4' })).rejects.toThrow('task_id child-4 is not a subagent session of this session.')
  })

  test('an unknown name and no target are plain-words errors', async () => {
    const { impl } = fakeApi({ children: [] })
    await expect(cloudStopChild(api(impl), { name: 'ghost' })).rejects.toThrow('No subagent of this session is named "ghost".')
    await expect(cloudStopChild(api(impl), {})).rejects.toThrow('Name the subagent to stop')
  })
})
