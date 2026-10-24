import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { MemoryLayerRef } from '@/services/tools/memory-copy'

/**
 * The `remember` platform tool (services/tools/platform/remember.ts): the
 * request it sends is the contract with `POST /v1/projects/:id/memory/remember`,
 * and the output is what the model and the UI read. The API is a fake on a
 * real port; the copy sync is recorded, not run (it writes /opt/kortix).
 */
const synced: Array<{ layers: readonly MemoryLayerRef[]; env: Record<string, string | undefined> }> = []
mock.module('@/services/tools/memory-copy', () => ({
  syncMemoryCopy: async (layers: readonly MemoryLayerRef[], env: Record<string, string | undefined>) => {
    synced.push({ layers, env })
  },
}))
const { default: remember } = await import('@/services/tools/platform/remember')

type Call = { path: string; auth: string | null; body: any }
let server: ReturnType<typeof Bun.serve> | undefined
let calls: Call[]
let env: Record<string, string | undefined>

function api(status: number, reply: unknown): void {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body: await req.json() })
      return typeof reply === 'string' ? new Response(reply, { status }) : Response.json(reply, { status })
    },
  })
  env = { KORTIX_API_URL: `http://127.0.0.1:${server.port}`, KORTIX_PROJECT_ID: 'proj-1', KORTIX_TOKEN: 'kortix_sb_test' }
}

const call = (args: Record<string, unknown>) =>
  remember.execute(args, { sessionId: 'ses_1', agent: 'kortix', directory: '/workspace', env, signal: new AbortController().signal })

const RESULT = {
  saved: true,
  page_id: 'page-1',
  version_id: 'ver-1',
  layer: { scope: 'channel', name: '#marketing', key: 'space-1', layer_id: 'layer-1', version: 12 },
  title: 'Q4 launch',
  status: 'confirmed',
  created: false,
  merged: true,
  copy_path: '/opt/kortix/memory/channel/workstreams/q4-launch.md',
}

beforeEach(() => {
  calls = []
  synced.length = 0
  env = {}
})
afterEach(() => {
  server?.stop(true)
  server = undefined
})

describe('remember', () => {
  test('a fact goes to the API with the session token; the result passes through and that layer copy is refreshed', async () => {
    api(200, RESULT)
    const result = await call({
      title: '  Q4 launch ',
      type: 'workstreams',
      fact: 'Launch moves to 12 November',
      section: 'Status',
      summary: 'The Q4 launch plan',
      layer: 'channel',
      outside: { label: 'Northwind newsletter', url: 'https://northwind.example/q4' },
    })
    expect(calls).toEqual([
      {
        path: '/v1/projects/proj-1/memory/remember',
        auth: 'Bearer kortix_sb_test',
        body: {
          title: 'Q4 launch',
          type: 'workstreams',
          fact: 'Launch moves to 12 November',
          section: 'Status',
          summary: 'The Q4 launch plan',
          layer: 'channel',
          outside: { label: 'Northwind newsletter', url: 'https://northwind.example/q4' },
        },
      },
    ])
    expect(result).toEqual(RESULT)
    expect(synced.map((entry) => entry.layers)).toEqual([[{ layer_id: 'layer-1', version: '12', dir: 'channel' }]])
  })

  test('a DM write refreshes the personal folder', async () => {
    api(200, { ...RESULT, layer: { scope: 'dm', name: 'Kortix', key: 'space-2', layer_id: 'layer-2', version: '3' } })
    await call({ title: 'Priya', type: 'people', body: '## Role\n- Runs marketing' })
    expect(calls[0]!.body).toEqual({ title: 'Priya', type: 'people', body: '## Role\n- Runs marketing' })
    expect(synced.map((entry) => entry.layers)).toEqual([[{ layer_id: 'layer-2', version: '3', dir: 'personal' }]])
  })

  test('arguments that are not a remember call are refused before any request', async () => {
    api(200, RESULT)
    const refused = {
      'title is required': { type: 'people', fact: 'x' },
      'type must be one of people, decisions, workstreams, playbooks': { title: 'Priya', type: 'note', fact: 'x' },
      'give exactly one of fact (one new fact) or body (the whole page)': { title: 'Priya', type: 'people', fact: 'x', body: 'y' },
      'layer must be one of channel, company, dm': { title: 'Priya', type: 'people', fact: 'x', layer: 'personal' },
      'outside must be { label, url? }': { title: 'Priya', type: 'people', fact: 'x', outside: { url: 'https://x.example' } },
      'summary must be a string': { title: 'Priya', type: 'people', fact: 'x', summary: 5 },
    }
    for (const [message, args] of Object.entries(refused)) expect(await call(args)).toBe(`Error: invalid_input: ${message}`)
    expect(await call({ title: 'Priya', type: 'people' })).toBe('Error: invalid_input: give exactly one of fact (one new fact) or body (the whole page)')
    expect(calls).toEqual([])
    expect(synced).toEqual([])
  })

  test('a 4xx answer is `Error: <code>: <message>` and syncs nothing; a 5xx or no token is a tool error', async () => {
    api(422, { error: 'The text looks like a secret. Memory never stores secrets.', code: 'secret_detected' })
    expect(await call({ title: 'Deploy', type: 'playbooks', fact: 'key AKIA…' })).toBe('Error: secret_detected: The text looks like a secret. Memory never stores secrets.')
    server!.stop(true)
    api(409, 'layer is archived')
    expect(await call({ title: 'Deploy', type: 'playbooks', fact: 'x' })).toBe('Error: 409: layer is archived')
    server!.stop(true)
    api(503, { error: 'down' })
    await expect(call({ title: 'Deploy', type: 'playbooks', fact: 'x' })).rejects.toThrow('memory is unavailable (503)')
    env = { ...env, KORTIX_TOKEN: '' }
    await expect(call({ title: 'Deploy', type: 'playbooks', fact: 'x' })).rejects.toThrow('KORTIX_TOKEN')
    expect(synced).toEqual([])
  })
})

describe('remember under a permission policy (pi)', () => {
  test('remember is an edit: edit: deny refuses it, edit: ask asks, its own rule wins', async () => {
    const { compilePermissionPolicy, resolvePolicyRule } = await import('@/harness/pi/interactions')
    const args = { title: 'Priya', type: 'people', fact: 'Runs marketing' }
    const rule = (permission: unknown) => resolvePolicyRule(compilePermissionPolicy(permission), 'remember', args, '/workspace')
    expect(rule({ edit: 'deny' })).toBe('deny')
    expect(rule({ edit: 'ask' })).toBe('ask')
    expect(rule({ edit: 'deny', remember: 'allow' })).toBe('allow')
    expect(rule({ bash: 'deny' })).toBeUndefined()
  })
})
