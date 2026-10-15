import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as toolHost from '@/services/tools/host'
import { toolAllowed, type CompiledAgentSet } from '@kortix/api-contract/runtime-relay'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { writeToolBridge } from '@/harness/open-code/tool-bridge'
import { createWorkspaceTools } from '@/harness/pi/tools'
import { loadHostConfig } from '@/lib/config/config'
import { createToolsRouter } from '@/routes/kortix/tools'
import { loadTools, toolBridgeKey, type HostedTool, type ToolContext } from '@/services/tools/host'

let server: ReturnType<typeof Bun.serve>
let requests: Array<{ path: string; auth: string | null; body: unknown }>
const catalog = { connectors: [{ slug: 'synthetic', name: 'Synthetic', provider: 'openapi', status: 'connected', actions: [{ path: 'items.read', name: 'Read items', description: 'Read synthetic items', risk: 'read', inputSchema: { type: 'object' } }, { path: 'items.write', name: 'Write items', description: 'Write synthetic items', risk: 'write', inputSchema: { type: 'object' } }] }] }
const denial = { ok: false, status: 'denied', reason: 'connector_not_assigned', details: { agent: 'reader' } }
const approval = { ok: false, status: 'pending_approval', execution_id: 'synthetic-execution', approval: { url: '/synthetic-approval' } }

beforeEach(() => {
  requests = []
  server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url)
    const body: unknown = request.method === 'POST' ? await request.json() : null
    requests.push({ path: url.pathname + url.search, auth: request.headers.get('authorization'), body })
    if (url.pathname === '/v1/connectors/catalog') return Response.json({ connectors: [...catalog.connectors, { slug: 'other', actions: [{ path: 'secret.read', description: 'must not leak' }] }] })
    if (typeof body === 'object' && body !== null && 'action' in body) {
      if (body.action === 'denied') return Response.json(denial, { status: 403 })
      if (body.action === 'approval') return Response.json(approval, { status: 202 })
      if (body.action === 'failure') return Response.json({ error: 'upstream_unavailable' }, { status: 503 })
      if (body.action === 'slow') return new Promise<Response>(() => {})
    }
    return Response.json({ ok: true, data: { items: ['synthetic'] } })
  } })
})
afterEach(() => server.stop(true))

function context(): ToolContext {
  return { sessionId: 'synthetic-session', agent: 'reader', directory: '/tmp', env: { KORTIX_API_URL: server.url.origin, KORTIX_TOKEN: 'synthetic-token' }, signal: new AbortController().signal }
}
async function tool(name: string): Promise<HostedTool> {
  const { tools } = await loadTools(null, undefined)
  const found = tools.find((entry) => entry.name === name)
  expect(found).toBeDefined()
  if (!found) throw new Error(`Missing registered tool: ${name}`)
  return found
}

test('legacy connector tools remain usable with compiled bash-denied policies', async () => {
  const compiled: CompiledAgentSet = { agent: { reader: { tools: { '*': false, 'kortix-connectors_call': true, 'kortix-connectors_describe': true } } } }
  const { tools } = await loadTools(null, compiled)
  const policy = compiled.agent.reader?.tools
  expect(toolAllowed(policy, 'bash')).toBe(false)
  expect(tools.filter((entry) => toolAllowed(policy, entry.name)).map((entry) => entry.name).sort()).toEqual(['kortix-connectors_call', 'kortix-connectors_describe'])
})

test('legacy describe splits at the first dot and returns only the named tool', async () => {
  const describe = await tool('kortix-connectors_describe')
  expect(await describe.execute({ tool: 'synthetic.items.read' }, context())).toEqual({ tool: 'synthetic.items.read', risk: 'read', description: 'Read synthetic items', inputSchema: { type: 'object' }, accounts: [], default_account: null })
  expect(requests).toEqual([{ path: '/v1/connectors/catalog?slug=synthetic&include_schemas=true', auth: 'Bearer synthetic-token', body: null }])
  await expect(describe.execute({ tool: 'synthetic.missing' }, context())).rejects.toThrow('not found')
  await expect(describe.execute({ tool: 'other.items.read' }, context())).rejects.toThrow('not found')
})

test('legacy call defaults absent args to an empty object', async () => {
  const call = await tool('kortix-connectors_call')
  await call.execute({ connector: 'synthetic', action: 'items.read' }, context())
  expect(requests[0]?.body).toEqual({ connector: 'synthetic', action: 'items.read', args: {} })
})

test('call sends auth, exact body, account and approval_context through the session gateway', async () => {
  const call = await tool('kortix-connectors_call')
  const ctx = context()
  ctx.env.KORTIX_API_URL += '/v1/'
  ctx.env.KORTIX_TOKEN = 'rotated-token'
  expect(await call.execute({ connector: 'synthetic', action: 'items.read', args: { id: 1 }, account: 'project', approval_context: 'Read synthetic items' }, ctx)).toEqual({ ok: true, data: { items: ['synthetic'] } })
  expect(requests).toEqual([{ path: '/v1/connectors/call', auth: 'Bearer rotated-token', body: { connector: 'synthetic', action: 'items.read', args: { id: 1 }, account: 'project', approval_context: 'Read synthetic items' } }])
})

test('denial, approval and failure envelopes survive unchanged, with no POST retries', async () => {
  const call = await tool('kortix-connectors_call')
  for (const [action, result] of [['denied', denial], ['approval', approval], ['failure', { error: 'upstream_unavailable' }]]) {
    expect(await call.execute({ connector: 'synthetic', action, args: {} }, context())).toEqual(result)
  }
  expect(requests).toHaveLength(3)
})

test('malformed arguments and missing live environment fail before HTTP', async () => {
  const call = await tool('kortix-connectors_call')
  for (const args of [{}, { connector: 'synthetic', action: 'read', args: 'bad' }, { connector: 'synthetic', action: 'read', args: [] }, { connector: 'synthetic', action: 'read', args: null }, { connector: 'synthetic', action: 'read', args: {}, account: 1 }, { connector: 'synthetic', action: 'read', args: {}, approval_context: false }]) {
    await expect(call.execute(args, context())).rejects.toThrow()
  }
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN']) {
    const ctx = context()
    delete ctx.env[key]
    await expect(call.execute({ connector: 'synthetic', action: 'read', args: {} }, ctx)).rejects.toThrow(key)
  }
  const describe = await tool('kortix-connectors_describe')
  await expect(describe.execute({ tool: 3 }, context())).rejects.toThrow('tool')
  expect(requests).toHaveLength(0)
})

test('turn cancellation aborts an in-flight call without retry', async () => {
  const call = await tool('kortix-connectors_call')
  const controller = new AbortController()
  const pending = call.execute({ connector: 'synthetic', action: 'slow', args: {} }, { ...context(), signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  await expect(pending).rejects.toThrow()
  expect(requests).toHaveLength(1)
})

for (const explicitSelection of [false, true]) {
  test(`connector bridge executes through HTTP with compiled default policy (explicit selection: ${explicitSelection})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connector-bridge-'))
    const compiled: CompiledAgentSet = {
      default_agent: 'reader',
      agent: {
        reader: { tools: { '*': false, 'kortix-connectors_call': true, 'kortix-connectors_describe': true } },
        blocked: { tools: { '*': false } },
      },
      ...(explicitSelection ? { kortix_tools: ['kortix-connectors_call', 'kortix-connectors_describe'] } : {}),
    }
    const env: NodeJS.ProcessEnv = {
      KORTIX_RUNTIME_STATE_DIR: join(dir, 'state'),
      KORTIX_SESSION_ID: 'synthetic-session',
      KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify(compiled),
    }
    const envFile = spyOn(toolHost, 'sessionEnv').mockImplementation(() => ({ KORTIX_API_URL: server.url.origin, KORTIX_TOKEN: 'synthetic-token' }))
    const app = new Hono()
    app.route('/kortix/tools', createToolsRouter(loadHostConfig({ KORTIX_PROJECT_TARGET: dir }), env))
    const daemon = Bun.serve({ port: 0, fetch: app.fetch })
    try {
      const path = join(dir, 'bridge.js')
      await writeToolBridge(path, { env, daemonPort: Number(daemon.port), projectRoot: null, configDir: null })
      const plugin: { KortixTools(input: unknown): Promise<{ tool: Record<string, { execute(args: unknown, context: unknown): Promise<string> }> }> } = await import(path)
      const hooks = await plugin.KortixTools({})
      if (explicitSelection) expect(Object.keys(hooks.tool).sort()).toEqual(['kortix-connectors_call', 'kortix-connectors_describe'])
      // No agent field exercises the route's compiled default_agent, not an explicit caller override.
      const ctx = { directory: dir, abort: new AbortController().signal }
      const describe = hooks.tool['kortix-connectors_describe']
      const call = hooks.tool['kortix-connectors_call']
      if (!describe || !call) throw new Error('Missing bridged connector tools')
      expect(JSON.parse(await describe.execute({ tool: 'synthetic.items.read' }, ctx))).toMatchObject({ tool: 'synthetic.items.read', risk: 'read' })
      expect(JSON.parse(await call.execute({ connector: 'synthetic', action: 'items.read' }, ctx))).toEqual({ ok: true, data: { items: ['synthetic'] } })
      expect(requests).toEqual([
        { path: '/v1/connectors/catalog?slug=synthetic&include_schemas=true', auth: 'Bearer synthetic-token', body: null },
        { path: '/v1/connectors/call', auth: 'Bearer synthetic-token', body: { connector: 'synthetic', action: 'items.read', args: {} } },
      ])
      const post = (name: string, agent?: string) => fetch(`http://127.0.0.1:${daemon.port}/kortix/tools/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${toolBridgeKey(env)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ args: {}, agent }),
      })
      if (!explicitSelection) {
        const response = await post('memory')
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'agent reader may not use memory' })
      }
      for (const name of ['kortix-connectors_call', 'kortix-connectors_describe']) {
        const response = await post(name, 'blocked')
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: `agent blocked may not use ${name}` })
      }
      expect(requests).toHaveLength(2)
      expect(JSON.parse(await call.execute({ connector: 'unknown', action: 'denied' }, ctx))).toEqual(denial)
      expect(requests[2]?.body).toEqual({ connector: 'unknown', action: 'denied', args: {} })

      const { tools } = await loadTools(null, compiled)
      const piCall = createWorkspaceTools(dir, tools, () => ({ sessionId: 'synthetic-session', agent: 'reader' })).find((entry) => entry.name === 'kortix-connectors_call')
      if (!piCall) throw new Error('Missing pi connector tool')
      const result = await piCall.execute('synthetic-call', { connector: 'synthetic', action: 'items.read' }, new AbortController().signal)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: true, data: { items: ['synthetic'] } }, null, 2) }])
    } finally {
      envFile.mockRestore()
      daemon.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
