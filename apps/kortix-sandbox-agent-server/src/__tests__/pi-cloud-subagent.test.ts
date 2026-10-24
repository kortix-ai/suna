/**
 * cloudSpawnSession (RFC Pillar 1 keystone) against a fake fetch and a fake
 * clock. Covers: the create POST shape (initial_prompt + named agent, parent
 * link via the bearer), onSession carrying the real child id, poll-to-idle →
 * completed, a failed child → error, a non-2xx create → error, and the
 * unsupported task_id resume. No real time, no network.
 */
import { describe, expect, test } from 'bun:test'
import { cloudSpawnSession, cloudSubagentApiFrom, type CloudSubagentApi } from '@/harness/pi/cloud-subagent'

const API: CloudSubagentApi = { apiUrl: 'https://api.example.com/v1', projectId: 'proj-1', token: 'sess-token' }

/** A fake fetch: one create reply, then session reads from a script of rows. */
function fakeFetch(create: { status: number; body: unknown }, reads: unknown[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = []
  let readIdx = 0
  const impl = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    calls.push({ url, method, headers, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) })
    if (method === 'POST') return new Response(JSON.stringify(create.body), { status: create.status })
    const row = reads[Math.min(readIdx++, reads.length - 1)]
    return new Response(JSON.stringify(row), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const fastOpts = { pollIntervalMs: 0, now: () => 0 }

describe('cloudSpawnSession', () => {
  test('creates a real child with the prompt + named agent, links via the bearer, and settles on idle', async () => {
    const { impl, calls } = fakeFetch(
      { status: 201, body: { session_id: 'child-123' } },
      [{ status: 'running', working: { state: 'working', pending_delivery: false } }, { status: 'running', working: { state: 'idle', pending_delivery: false } }],
    )
    const seen: Array<{ sessionId: string; model: { providerID: string; modelID: string } }> = []
    const result = await cloudSpawnSession(
      { ...API, fetchImpl: impl },
      { title: 'Check it', agent: 'reviewer', systemPrompt: 'ignored in cloud', prompt: 'review the diff', onSession: (s) => seen.push(s) },
      fastOpts,
    )
    expect(result.status).toBe('completed')
    expect(result.sessionId).toBe('child-123')
    expect(seen).toEqual([{ sessionId: 'child-123', model: { providerID: 'kortix', modelID: 'default' } }])
    const create = calls.find((c) => c.method === 'POST')!
    expect(create.url).toBe('https://api.example.com/v1/projects/proj-1/sessions')
    expect(create.headers.authorization).toBe('Bearer sess-token')
    expect(create.body).toMatchObject({ initial_prompt: 'review the diff', agent_name: 'reviewer', name: 'Check it' })
  })

  test('a built-in subagent name is not sent as agent_name (no cloud agent for it)', async () => {
    const { impl, calls } = fakeFetch({ status: 202, body: { session_id: 'child-9' } }, [{ status: 'completed', working: { state: 'idle' } }])
    await cloudSpawnSession({ ...API, fetchImpl: impl }, { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fastOpts)
    expect(calls.find((c) => c.method === 'POST')!.body).not.toHaveProperty('agent_name')
  })

  test('a failed child session returns error', async () => {
    const { impl } = fakeFetch({ status: 201, body: { session_id: 'child-err' } }, [{ status: 'failed', working: { state: 'idle' } }])
    const result = await cloudSpawnSession({ ...API, fetchImpl: impl }, { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fastOpts)
    expect(result).toMatchObject({ sessionId: 'child-err', status: 'error' })
  })

  test('a non-2xx create returns error, not a child', async () => {
    const { impl } = fakeFetch({ status: 403, body: { error: 'nope' } }, [])
    const result = await cloudSpawnSession({ ...API, fetchImpl: impl }, { title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fastOpts)
    expect(result.status).toBe('error')
    expect(result.error).toContain('403')
  })

  test('task_id resume is not supported in cloud mode', async () => {
    const { impl } = fakeFetch({ status: 201, body: { session_id: 'x' } }, [])
    await expect(
      cloudSpawnSession({ ...API, fetchImpl: impl }, { sessionId: 'child-1', title: 'x', agent: 'general', systemPrompt: '', prompt: 'go' }, fastOpts),
    ).rejects.toThrow('resume')
  })

  test('cloudSubagentApiFrom is null without a control plane', () => {
    expect(cloudSubagentApiFrom({ apiUrl: 'https://a', projectId: 'p' })).toBeNull()
    expect(cloudSubagentApiFrom({ apiUrl: 'https://a', projectId: 'p', sandboxToken: 't' })).toEqual({ apiUrl: 'https://a', projectId: 'p', token: 't' })
  })
})
