import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { buildOpencodeConfigContent } from '@/harness/open-code/lifecycle'
import { toolAccessRules } from '@/harness/open-code/tool-access'
import { writeToolBridge } from '@/harness/open-code/tool-bridge'
import type { Config } from '@/lib/config/config'
import { createToolsRouter } from '@/routes/kortix/tools'
import { toolBridgeKey } from '@/services/tools/host'

/**
 * OpenCode reaches the hosted tools (services/tools) through a plugin the
 * daemon writes (harness/open-code/tool-bridge.ts). These tests import that
 * plugin the way OpenCode 1.18.23 does — `import(file://…)`, then call the
 * export with the plugin input — and run its tools against a live daemon route.
 */
const LOOKUP = `export default {
  description: 'Look up an order by id.',
  parameters: { type: 'object', properties: { id: { type: 'string' }, verbose: { type: 'boolean' } }, required: ['id'] },
  async execute(args, context) {
    if (args.id === 'boom') throw new Error('order service is down')
    return 'order ' + args.id + ' for ' + context.agent + ' in ' + context.directory
  },
}
`

type BridgeHooks = {
  tool: Record<string, { description: string; args: Record<string, unknown>; execute(args: unknown, context: unknown): Promise<string> }>
  'tool.definition': (input: { toolID: string }, output: { jsonSchema?: unknown }) => Promise<void>
}

let dir: string
let server: ReturnType<typeof Bun.serve> | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opencode-tool-bridge-'))
})
afterEach(() => {
  server?.stop(true)
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

/** A project checkout with one tool, its OpenCode config dir, and a daemon serving `/kortix/tools`. */
function rig(configDirTools: string[] = [], kortixTools?: string[]) {
  const project = join(dir, 'project')
  mkdirSync(join(project, 'tools'), { recursive: true })
  writeFileSync(join(project, 'tools/lookup.ts'), LOOKUP)
  const configDir = join(project, 'harnesses/opencode')
  mkdirSync(join(configDir, 'tools'), { recursive: true })
  for (const name of configDirTools) writeFileSync(join(configDir, 'tools', `${name}.ts`), 'export default {}\n')
  const env: NodeJS.ProcessEnv = {
    KORTIX_RUNTIME_STATE_DIR: join(dir, 'state'),
    KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({
      agent: { kortix: {}, reader: { tools: { '*': false, read: true } } },
      project_tools: { lookup_order: 'tools/lookup.ts' },
      ...(kortixTools ? { kortix_tools: kortixTools } : {}),
    }),
  }
  const app = new Hono()
  app.route('/kortix/tools', createToolsRouter({ sandboxToken: 'token', projectTarget: project } as Config, env))
  server = Bun.serve({ port: 0, fetch: app.fetch })
  return { project, configDir, env, port: server.port as number }
}

async function bridge(path: string): Promise<BridgeHooks> {
  // A fresh URL per load: OpenCode imports the module once; the list file is what changes.
  const mod = (await import(`${path}?load=${Math.random()}`)) as Record<string, (input: unknown) => Promise<BridgeHooks>>
  expect(Object.keys(mod)).toEqual(['KortixTools'])
  return mod.KortixTools!({})
}

describe('the hosted tools bridge plugin', () => {
  test('lists the Kortix tools and the project tools, with the daemon URL and the box key', async () => {
    const r = rig()
    const path = join(dir, 'home/.config/kortix-tools.js')
    expect(await writeToolBridge(path, { env: r.env, daemonPort: r.port, projectRoot: r.project, configDir: r.configDir })).toBe(`file://${path}`)
    const list = JSON.parse(readFileSync(path.replace(/\.js$/, '.json'), 'utf8'))
    expect(list.url).toBe(`http://127.0.0.1:${r.port}/kortix/tools/`)
    expect(list.key).toBe(toolBridgeKey(r.env))
    expect(statSync(path.replace(/\.js$/, '.json')).mode & 0o777).toBe(0o600)
    expect(list.tools.map((tool: { name: string }) => tool.name)).toEqual(['web_search', 'image_search', 'scrape_webpage', 'memory', 'show', 'lookup_order'])
  })

  test('a Kortix tool the project does not list is not in the plugin, and the daemon refuses a call to it', async () => {
    const r = rig([], ['web_search', 'image_search', 'scrape_webpage', 'memory'])
    const path = join(dir, 'home/.config/kortix-tools.js')
    await writeToolBridge(path, { env: r.env, daemonPort: r.port, projectRoot: r.project, configDir: r.configDir })
    const hooks = await bridge(path)
    expect(Object.keys(hooks.tool)).toEqual(['web_search', 'image_search', 'scrape_webpage', 'memory', 'lookup_order'])
    const response = await fetch(`http://127.0.0.1:${r.port}/kortix/tools/show`, {
      method: 'POST',
      headers: { authorization: `Bearer ${toolBridgeKey(r.env)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ args: { action: 'show', type: 'text', content: 'hi' }, agent: 'kortix' }),
    })
    expect([response.status, await response.json()]).toEqual([404, { error: 'no tool named show is loaded' }])
  })

  test("a tool the config dir defines itself keeps the project's file", async () => {
    const r = rig(['web_search', 'memory'])
    const path = join(dir, 'home/.config/kortix-tools.js')
    await writeToolBridge(path, { env: r.env, daemonPort: r.port, projectRoot: r.project, configDir: r.configDir })
    const hooks = await bridge(path)
    expect(Object.keys(hooks.tool)).toEqual(['image_search', 'scrape_webpage', 'show', 'lookup_order'])
  })

  test('each tool runs on the daemon; the model sees the tool’s own JSON Schema', async () => {
    const r = rig()
    const path = join(dir, 'home/.config/kortix-tools.js')
    await writeToolBridge(path, { env: r.env, daemonPort: r.port, projectRoot: r.project, configDir: r.configDir })
    const hooks = await bridge(path)
    const lookup = hooks.tool.lookup_order!
    expect(lookup.description).toBe('Look up an order by id.')
    // JSON Schema properties, not Zod: OpenCode takes the non-Zod path.
    expect(lookup.args).toEqual({ id: { type: 'string' }, verbose: { type: 'boolean' } })
    const output: { jsonSchema?: unknown } = {}
    await hooks['tool.definition']({ toolID: 'lookup_order' }, output)
    expect(output.jsonSchema).toEqual({ type: 'object', properties: { id: { type: 'string' }, verbose: { type: 'boolean' } }, required: ['id'] })
    const context = { agent: 'kortix', directory: '/workspace', abort: new AbortController().signal }
    expect(await lookup.execute({ id: '9' }, context)).toBe('order 9 for kortix in /workspace')
    await expect(lookup.execute({ id: 'boom' }, context)).rejects.toThrow('order service is down')
    await expect(lookup.execute({ id: '9' }, { ...context, agent: 'reader' })).rejects.toThrow('agent reader may not use lookup_order')
  })

  test('a rewritten list reaches the next initialization without a new import', async () => {
    const r = rig()
    const path = join(dir, 'home/.config/kortix-tools.js')
    await writeToolBridge(path, { env: r.env, daemonPort: r.port, projectRoot: r.project, configDir: r.configDir })
    const mod = (await import(path)) as Record<string, (input: unknown) => Promise<BridgeHooks>>
    expect(Object.keys((await mod.KortixTools!({})).tool)).toContain('lookup_order')
    await writeToolBridge(path, { env: r.env, daemonPort: r.port, projectRoot: null, configDir: r.configDir })
    expect(Object.keys((await mod.KortixTools!({})).tool)).not.toContain('lookup_order')
  })
})

describe('toolAccessRules', () => {
  test('a removed tool is denied after every other rule, so no rule re-opens it', () => {
    expect(toolAccessRules({ bash: false }, { bash: 'allow', '*': 'allow' }, 'allow')).toEqual({ '*': 'allow', bash: 'deny', 'pty_*': 'deny' })
    expect(toolAccessRules({ write: false, read: true }, 'ask', undefined)).toEqual({ '*': 'ask', edit: 'deny' })
  })

  test('an allowlist denies `*` first and keeps the action each allowed tool had', () => {
    const rules = toolAccessRules(
      { '*': false, read: true, bash: true, web_search: true },
      { bash: { 'git *': 'allow', '*': 'ask' }, edit: 'allow', pty_spawn: 'ask', '*': 'ask' },
      { external_directory: 'deny', '*': 'allow' },
    )
    expect(rules).toEqual({
      '*': 'deny',
      invalid: 'allow',
      bash: { 'git *': 'allow', '*': 'ask' },
      pty_spawn: 'ask',
      read: 'ask',
      'pty_*': 'ask',
      web_search: 'ask',
      external_directory: 'ask',
      doom_loop: 'ask',
    })
    expect(Object.keys(rules)[0]).toBe('*')
  })

  test('with no agent rule, an allowed tool falls back to the project rule, then to allow', () => {
    expect(toolAccessRules({ '*': false, read: true }, undefined, { read: 'ask', '*': 'deny' })).toMatchObject({ '*': 'deny', read: 'ask' })
    expect(toolAccessRules({ '*': false, lookup_order: true }, undefined, undefined)).toEqual({
      '*': 'deny',
      invalid: 'allow',
      lookup_order: 'allow',
      external_directory: 'ask',
      doom_loop: 'ask',
    })
  })
})

describe('the composed OpenCode config', () => {
  test('drops kortix_tools: OpenCode refuses a config with a key its schema does not have', async () => {
    const env: NodeJS.ProcessEnv = { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { open: {} }, kortix_tools: ['memory'], project_tools: { x: 'tools/x.ts' } }) }
    const config = JSON.parse((await buildOpencodeConfigContent(env, {}))!)
    expect(Object.keys(config)).not.toContain('kortix_tools')
    expect(Object.keys(config)).not.toContain('project_tools')
  })

  test('carries the bridge plugin, drops project_tools, and turns agent tool access into permission rules', async () => {
    const env: NodeJS.ProcessEnv = {
      KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({
        agent: {
          researcher: { tools: { '*': false, read: true, web_search: true }, permission: { bash: 'allow' } },
          builder: { tools: { bash: false }, permission: { bash: 'allow' } },
          open: {},
        },
        project_tools: { lookup_order: 'tools/lookup.ts' },
      }),
    }
    const config = JSON.parse((await buildOpencodeConfigContent(env, { toolBridgeSpec: 'file:///home/kortix/.config/kortix-tools.js' }))!)
    expect(config.plugin).toEqual(['file:///home/kortix/.config/kortix-tools.js'])
    expect(config.project_tools).toBeUndefined()
    expect(config.agent.researcher.tools).toBeUndefined()
    expect(config.agent.researcher.permission).toMatchObject({ '*': 'deny', read: 'allow', web_search: 'allow' })
    expect(config.agent.researcher.permission.bash).toBeUndefined()
    expect(config.agent.builder.permission).toMatchObject({ bash: 'deny', 'pty_*': 'deny' })
    expect(Object.keys(config.agent.builder.permission).slice(-2)).toEqual(['bash', 'pty_*'])
    expect(config.agent.open.permission).toBeUndefined()
  })
})
