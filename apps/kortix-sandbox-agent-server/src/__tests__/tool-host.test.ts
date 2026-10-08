import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config } from '@/lib/config/config'
import { createToolsRouter } from '@/routes/kortix/tools'
import { KORTIX_TOOLS, hostedTool, loadTools, runTool, sessionEnv, toolBridgeKey } from '@/services/tools/host'
import { signTestUserContext } from './helpers/open-code-harness'

/**
 * The tool host (services/tools/host.ts): what every harness loads, and the
 * route an out-of-process harness calls. A project tool is a plain module on
 * disk, as an author writes it.
 */
const LOOKUP = `export default {
  description: 'Look up an order by id.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async execute(args, context) {
    if (args.id === 'boom') throw new Error('order service is down')
    return { order: args.id, agent: context.agent, directory: context.directory, session: context.sessionId }
  },
}
`

let root: string
let state: string
const ctx = () => ({ sessionId: 'ses_1', agent: 'kortix', directory: root, env: {}, signal: new AbortController().signal })
const write = (path: string, source: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), source)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tool-host-'))
  state = mkdtempSync(join(tmpdir(), 'tool-host-state-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(state, { recursive: true, force: true })
})

describe('loadTools', () => {
  test('the Kortix tools load with no project tool declared', async () => {
    const { tools, failed } = await loadTools(root, undefined)
    expect(tools.map((tool) => tool.name)).toEqual(['web_search', 'image_search', 'scrape_webpage', 'memory', 'show'])
    expect(tools.every((tool) => tool.source === 'kortix')).toBe(true)
    expect(failed).toEqual([])
  })

  test('a declared module loads from any folder and runs with the call context', async () => {
    write('integrations/orders/lookup.ts', LOOKUP)
    const { tools } = await loadTools(root, { lookup_order: 'integrations/orders/lookup.ts' })
    const tool = tools.find((entry) => entry.name === 'lookup_order')!
    expect(tool.source).toBe('integrations/orders/lookup.ts')
    expect(JSON.parse(await runTool(tool, { id: '42' }, ctx()))).toEqual({ order: '42', agent: 'kortix', directory: root, session: 'ses_1' })
    expect(hostedTool('lookup_order')).toBe(tool)
  })

  test('a project tool replaces the Kortix tool of its name', async () => {
    write('tools/memory.ts', `export default { description: 'Team memory.', parameters: { type: 'object', properties: {} }, execute: () => 'team' }\n`)
    const { tools } = await loadTools(root, { memory: 'tools/memory.ts' })
    expect(tools.filter((tool) => tool.name === 'memory').map((tool) => tool.source)).toEqual(['tools/memory.ts'])
    expect(await runTool(hostedTool('memory')!, {}, ctx())).toBe('team')
  })

  test('a module that does not load is reported and left out; the others load', async () => {
    write('tools/ok.ts', LOOKUP)
    write('tools/no-default.ts', `export const tool = {}\n`)
    write('tools/no-schema.ts', `export default { description: 'x', execute: () => 'x' }\n`)
    write('tools/throws.ts', `throw new Error('top-level failure')\n`)
    const { tools, failed } = await loadTools(root, {
      ok: 'tools/ok.ts',
      no_default: 'tools/no-default.ts',
      no_schema: 'tools/no-schema.ts',
      throws: 'tools/throws.ts',
      missing: 'tools/missing.ts',
      escapes: '../outside.ts',
    })
    expect(tools.map((tool) => tool.name)).toContain('ok')
    expect(Object.fromEntries(failed.map(({ name, error }) => [name, error]))).toEqual({
      no_default: 'tools/no-default.ts: the module has no default export object',
      no_schema: 'tools/no-schema.ts: `parameters` must be a JSON Schema object (`{ type: "object", properties: { … } }`)',
      throws: 'tools/throws.ts: top-level failure',
      missing: 'tools/missing.ts does not exist',
      escapes: '../outside.ts leaves the project checkout',
    })
  })

  test('with no project checkout only the Kortix tools load', async () => {
    const { tools, failed } = await loadTools(null, { lookup_order: 'tools/lookup.ts' })
    expect(tools).toHaveLength(Object.keys(KORTIX_TOOLS).length)
    expect(failed).toEqual([{ name: 'lookup_order', error: 'this session has no project checkout to load it from' }])
  })

  test('an edited module is imported again on the next load', async () => {
    write('tools/v.ts', `export default { description: 'v', parameters: { type: 'object', properties: {} }, execute: () => 'one' }\n`)
    await loadTools(root, { v: 'tools/v.ts' })
    expect(await runTool(hostedTool('v')!, {}, ctx())).toBe('one')
    write('tools/v.ts', `export default { description: 'v', parameters: { type: 'object', properties: {} }, execute: () => 'two' }\n`)
    const later = new Date(statSync(join(root, 'tools/v.ts')).mtimeMs + 5_000)
    utimesSync(join(root, 'tools/v.ts'), later, later)
    await loadTools(root, { v: 'tools/v.ts' })
    expect(await runTool(hostedTool('v')!, {}, ctx())).toBe('two')
  })
})

describe('runTool', () => {
  const echo = (value: unknown) => ({ name: 'echo', description: 'e', parameters: { type: 'object' }, execute: () => value })

  test('a string is the output, any other value is indented JSON, nothing is empty', async () => {
    expect(await runTool(echo('plain'), {}, ctx())).toBe('plain')
    expect(await runTool(echo({ a: [1] }), {}, ctx())).toBe('{\n  "a": [\n    1\n  ]\n}')
    expect(await runTool(echo(undefined), {}, ctx())).toBe('')
  })

  test('an output past 50 KB is saved whole; the model reads its head and the file path', async () => {
    const big = 'x'.repeat(200 * 1024)
    const output = await runTool(echo(big), {}, ctx())
    expect(Buffer.byteLength(output)).toBeLessThan(50 * 1024)
    const file = /The whole output is in (\S+);/.exec(output)![1]!
    expect(readFileSync(file, 'utf8')).toBe(big)
    expect(output).toContain(`[Output truncated: ${200 * 1024} bytes, 1 lines.`)
    rmSync(file)
  })

  test('an output past 2000 lines is saved whole too', async () => {
    const output = await runTool(echo(Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n')), {}, ctx())
    expect(output.split('\n').length).toBeLessThan(2_000)
    expect(output).toContain('5000 lines')
    rmSync(/The whole output is in (\S+);/.exec(output)![1]!)
  })
})

describe('sessionEnv', () => {
  test('the live agent env file wins over the boot env: a changed, an added and a revoked secret', () => {
    const file = join(state, 'agent-env.sh')
    process.env.TOOL_HOST_TEST_CHANGED = 'boot value'
    process.env.TOOL_HOST_TEST_REVOKED = 'boot value'
    writeFileSync(
      file,
      [
        '# Generated by kortix-sandbox-agent-server.',
        'unset TOOL_HOST_TEST_REVOKED',
        "export TOOL_HOST_TEST_CHANGED='pushed value'",
        `export TOOL_HOST_TEST_QUOTED='it'\\''s'`,
        "export TOOL_HOST_TEST_MULTILINE='line one",
        "line two'",
        '',
      ].join('\n'),
    )
    try {
      const env = sessionEnv(file)
      expect(env.TOOL_HOST_TEST_CHANGED).toBe('pushed value')
      expect(env.TOOL_HOST_TEST_REVOKED).toBeUndefined()
      expect(env.TOOL_HOST_TEST_QUOTED).toBe("it's")
      expect(env.TOOL_HOST_TEST_MULTILINE).toBe('line one\nline two')
      expect(sessionEnv(join(state, 'absent.sh')).TOOL_HOST_TEST_CHANGED).toBe('boot value')
    } finally {
      delete process.env.TOOL_HOST_TEST_CHANGED
      delete process.env.TOOL_HOST_TEST_REVOKED
    }
  })
})

describe('toolBridgeKey', () => {
  test('one key per box, kept owner-only in the runtime state dir', () => {
    const env = { KORTIX_RUNTIME_STATE_DIR: state }
    const key = toolBridgeKey(env)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(toolBridgeKey(env)).toBe(key)
    expect(statSync(join(state, 'tool-bridge.key')).mode & 0o777).toBe(0o600)
  })
})

describe('POST /kortix/tools/:name', () => {
  const TOKEN = 'sandbox-token'
  const compiled = JSON.stringify({ agent: { kortix: {}, reader: { tools: { '*': false, read: true } } } })
  const env = () => ({ KORTIX_RUNTIME_STATE_DIR: state, KORTIX_SESSION_ID: 'ses_box', KORTIX_COMPILED_AGENT_CONFIG: compiled })
  const call = (name: string, body: unknown, headers: Record<string, string>) =>
    createToolsRouter({ sandboxToken: TOKEN, projectTarget: root } as Config, env()).request(`/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  const bridge = () => ({ Authorization: `Bearer ${toolBridgeKey(env())}` })

  beforeEach(async () => {
    write('tools/lookup.ts', LOOKUP)
    await loadTools(root, { lookup_order: 'tools/lookup.ts' })
  })

  test('the bridge key runs the tool for this box session', async () => {
    const response = await call('lookup_order', { args: { id: '7' }, agent: 'kortix', directory: root }, bridge())
    expect(response.status).toBe(200)
    expect(JSON.parse(((await response.json()) as { output: string }).output)).toEqual({ order: '7', agent: 'kortix', directory: root, session: 'ses_box' })
  })

  test('the sandbox token and a signed user context are accepted too; anything else is 401', async () => {
    expect((await call('lookup_order', { args: { id: '1' }, agent: 'kortix' }, { Authorization: `Bearer ${TOKEN}` })).status).toBe(200)
    const userContext = signTestUserContext({ userId: 'u1', sandboxId: 's1', sandboxRole: 'owner' }, TOKEN)
    expect((await call('lookup_order', { args: { id: '1' }, agent: 'kortix' }, { 'X-Kortix-User-Context': userContext })).status).toBe(200)
    expect((await call('lookup_order', { args: { id: '1' }, agent: 'kortix' }, { Authorization: 'Bearer wrong' })).status).toBe(401)
  })

  test('an unknown tool is 404, an agent without access is 403, a thrown error is 422', async () => {
    expect(await (await call('nope', { agent: 'kortix' }, bridge())).json()).toEqual({ error: 'no tool named nope is loaded' })
    const denied = await call('lookup_order', { args: { id: '1' }, agent: 'reader' }, bridge())
    expect([denied.status, await denied.json()]).toEqual([403, { error: 'agent reader may not use lookup_order' }])
    const thrown = await call('lookup_order', { args: { id: 'boom' }, agent: 'kortix' }, bridge())
    expect([thrown.status, await thrown.json()]).toEqual([422, { error: 'order service is down' }])
  })
})
