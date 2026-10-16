/**
 * kortix.yaml v3 commands through the OpenCode proxy, against a real upstream.
 *
 * `GET /command` lists only the compiled commands, each with `agents`.
 * `POST /session/:id/command` for an agent the command does not list answers
 * `403 command_not_enabled` and never reaches OpenCode. v1/v2 pass through
 * byte for byte.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { Opencode } from '@/harness/open-code/lifecycle'
import { createOpenCodeProxyService } from '@/harness/open-code/proxy'

const UPSTREAM_COMMANDS = [
  { name: 'init', description: 'guided AGENTS.md setup', source: 'command', template: 'x', hints: [] },
  { name: 'weekly', description: 'Weekly summary', source: 'command', template: 'Summarize $ARGUMENTS', hints: ['$ARGUMENTS'] },
  { name: 'research', description: 'a skill', source: 'skill', template: 'y', hints: [] },
]
const V3 = {
  schema: 3,
  default_agent: 'lead',
  agent: { lead: { mode: 'primary' }, helper: { mode: 'all' } },
  commands: { weekly: { description: 'Weekly summary', template: 'Summarize $ARGUMENTS', agents: ['lead'] } },
}

let upstream: ReturnType<typeof Bun.serve>
const received: Array<{ path: string; body: string }> = []

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      received.push({ path: url.pathname, body: await req.text() })
      if (url.pathname === '/command') return Response.json(UPSTREAM_COMMANDS)
      return Response.json({ ok: true })
    },
  })
})
afterAll(() => upstream.stop(true))
afterEach(() => {
  received.length = 0
  delete process.env.KORTIX_COMPILED_AGENT_CONFIG
  delete process.env.KORTIX_AGENT_NAME
})

const proxy = () =>
  createOpenCodeProxyService({ getInternalUrl: () => `http://127.0.0.1:${upstream.port}` } as unknown as Opencode, {
    settled: async () => undefined,
  } as never)

async function call(method: string, path: string, body?: unknown) {
  const result = await proxy().forward({
    method,
    path,
    search: '',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: body === undefined ? null : new Response(JSON.stringify(body)).body,
  })
  return { status: result.status, json: JSON.parse(await new Response(result.body).text()) }
}

describe('kortix.yaml v3 commands', () => {
  test('GET /command lists only the compiled commands, each with its agents', async () => {
    process.env.KORTIX_COMPILED_AGENT_CONFIG = JSON.stringify(V3)
    const { status, json } = await call('GET', '/command')
    expect(status).toBe(200)
    expect(json).toEqual([{ ...UPSTREAM_COMMANDS[1], agents: ['lead'] }])
  })

  test('an agent that enables the command runs it: the body reaches OpenCode unchanged', async () => {
    process.env.KORTIX_COMPILED_AGENT_CONFIG = JSON.stringify(V3)
    const body = { command: 'weekly', arguments: 'last week', agent: 'lead' }
    const { status } = await call('POST', '/session/ses_1/command', body)
    expect(status).toBe(200)
    expect(received).toEqual([{ path: '/session/ses_1/command', body: JSON.stringify(body) }])
  })

  test('an agent that does not enable it is refused with 403, and OpenCode never sees it', async () => {
    process.env.KORTIX_COMPILED_AGENT_CONFIG = JSON.stringify(V3)
    const { status, json } = await call('POST', '/session/ses_1/command', { command: 'weekly', arguments: '', agent: 'helper' })
    expect(status).toBe(403)
    expect(json).toEqual({ error: 'command_not_enabled', command: 'weekly', agent: 'helper' })
    expect(received).toEqual([])
  })

  test('no agent in the body: the session agent decides (KORTIX_AGENT_NAME, else default_agent)', async () => {
    process.env.KORTIX_COMPILED_AGENT_CONFIG = JSON.stringify(V3)
    expect((await call('POST', '/session/ses_1/command', { command: 'weekly', arguments: '' })).status).toBe(200)
    process.env.KORTIX_AGENT_NAME = 'helper'
    expect(await call('POST', '/session/ses_1/command', { command: 'weekly', arguments: '' })).toEqual({
      status: 403,
      json: { error: 'command_not_enabled', command: 'weekly', agent: 'helper' },
    })
  })

  test("a command the set does not compile (OpenCode's own, a skill) is refused", async () => {
    process.env.KORTIX_COMPILED_AGENT_CONFIG = JSON.stringify(V3)
    for (const command of ['init', 'research']) {
      expect((await call('POST', '/session/ses_1/command', { command, arguments: '', agent: 'lead' })).status).toBe(403)
    }
  })
})

describe('v1/v2 commands are unchanged', () => {
  test('GET /command passes every command through, with no agents', async () => {
    process.env.KORTIX_COMPILED_AGENT_CONFIG = JSON.stringify({ agent: { support: { mode: 'primary' } } })
    expect((await call('GET', '/command')).json).toEqual(UPSTREAM_COMMANDS)
  })

  test('POST /session/:id/command reaches OpenCode for any agent', async () => {
    const { status } = await call('POST', '/session/ses_1/command', { command: 'init', arguments: '', agent: 'anyone' })
    expect(status).toBe(200)
    expect(received.map((r) => r.path)).toEqual(['/session/ses_1/command'])
  })
})

describe('the session agent falls back to default_agent when the compiled set does not declare it', () => {
  // A session can carry an agent name from the default branch's governance while
  // its own ref compiles a different set (a session on a branch). pi already falls back.
  test('an unknown KORTIX_AGENT_NAME resolves to the set\'s default_agent; a declared one stays', async () => {
    const { sessionAgentName } = await import('@/harness/open-code/manifest-v3')
    const set = { schema: 3, default_agent: 'lead', agent: { lead: {}, other: {} } } as never
    expect(sessionAgentName(set, { KORTIX_AGENT_NAME: 'kortix' })).toBe('lead')
    expect(sessionAgentName(set, { KORTIX_AGENT_NAME: 'other' })).toBe('other')
    expect(sessionAgentName(set, { KORTIX_AGENT_NAME: 'default' })).toBe('lead')
    expect(sessionAgentName(set, {})).toBe('lead')
  })
})
