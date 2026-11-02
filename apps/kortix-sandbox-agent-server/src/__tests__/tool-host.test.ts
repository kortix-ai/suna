import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { KORTIX_TOOLS, hostedTool, loadTools, runTool, sessionEnv } from '@/services/tools/host'

/**
 * The tool host (services/tools/host.ts): what pi loads. A project tool is a
 * plain module on disk, as an author writes it.
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
    expect(tools.map((tool) => tool.name)).toEqual(['web_search', 'image_search', 'image_gen', 'scrape_webpage', 'show'])
    expect(tools.every((tool) => tool.source === 'kortix')).toBe(true)
    expect(failed).toEqual([])
  })

  test('a declared module loads from any folder and runs with the call context', async () => {
    write('integrations/orders/lookup.ts', LOOKUP)
    const { tools } = await loadTools(root, { project_tools: { lookup_order: 'integrations/orders/lookup.ts' } })
    const tool = tools.find((entry) => entry.name === 'lookup_order')!
    expect(tool.source).toBe('integrations/orders/lookup.ts')
    expect(JSON.parse(await runTool(tool, { id: '42' }, ctx()))).toEqual({ order: '42', agent: 'kortix', directory: root, session: 'ses_1' })
    expect(hostedTool('lookup_order')).toBe(tool)
  })

  test('kortix_tools picks the Kortix tools; absent, all of them load', async () => {
    const names = async (compiled: Parameters<typeof loadTools>[1]) => (await loadTools(root, compiled)).tools.map((tool) => tool.name)
    const all = ['web_search', 'image_search', 'image_gen', 'scrape_webpage', 'show']
    expect(await names(undefined)).toEqual(all)
    expect(await names(null)).toEqual(all)
    expect(await names({})).toEqual(all)
    expect(await names({ kortix_tools: ['web_search', 'image_search', 'scrape_webpage'] })).toEqual(['web_search', 'image_search', 'scrape_webpage'])
    // `memory` is retired (2026-10-30): a compiled config that still names it loads nothing for it.
    expect(await names({ kortix_tools: ['web_search', 'memory'] })).toEqual(['web_search'])
    // A platform tool loads only when named: `kortix_memory` is My Kortix's.
    expect(await names({ kortix_tools: ['kortix_memory'] })).toEqual(['kortix_memory'])
    expect(hostedTool('show')).toBeUndefined()
    expect(await names({ kortix_tools: [] })).toEqual([])
    expect(hostedTool('web_search')).toBeUndefined()
  })

  test('an override in project_tools loads in place of a Kortix tool kortix_tools does not list', async () => {
    write('tools/web_search.ts', `export default { description: 'Our search.', parameters: { type: 'object', properties: {} }, execute: () => 'ours' }\n`)
    const { tools } = await loadTools(root, { kortix_tools: ['show'], project_tools: { web_search: 'tools/web_search.ts' } })
    expect(tools.map((tool) => [tool.name, tool.source])).toEqual([
      ['show', 'kortix'],
      ['web_search', 'tools/web_search.ts'],
    ])
    expect(await runTool(hostedTool('web_search')!, {}, ctx())).toBe('ours')
  })

  test('a project tool replaces the Kortix tool of its name', async () => {
    write('tools/show.ts', `export default { description: 'Our show.', parameters: { type: 'object', properties: {} }, execute: () => 'team' }\n`)
    const { tools } = await loadTools(root, { project_tools: { show: 'tools/show.ts' } })
    expect(tools.filter((tool) => tool.name === 'show').map((tool) => tool.source)).toEqual(['tools/show.ts'])
    expect(await runTool(hostedTool('show')!, {}, ctx())).toBe('team')
  })

  test('an ejected copy of the retired `memory` tool keeps loading as a project tool', async () => {
    write('tools/memory.ts', `export default { description: 'Team memory.', parameters: { type: 'object', properties: {} }, execute: () => 'team' }\n`)
    const { tools } = await loadTools(root, { project_tools: { memory: 'tools/memory.ts' } })
    expect(tools.filter((tool) => tool.name === 'memory').map((tool) => tool.source)).toEqual(['tools/memory.ts'])
    expect(await runTool(hostedTool('memory')!, {}, ctx())).toBe('team')
  })

  test('a module that does not load is reported and left out; the others load', async () => {
    write('tools/ok.ts', LOOKUP)
    write('tools/no-default.ts', `export const tool = {}\n`)
    write('tools/no-schema.ts', `export default { description: 'x', execute: () => 'x' }\n`)
    write('tools/throws.ts', `throw new Error('top-level failure')\n`)
    const { tools, failed } = await loadTools(root, {
      project_tools: {
        ok: 'tools/ok.ts',
        no_default: 'tools/no-default.ts',
        no_schema: 'tools/no-schema.ts',
        throws: 'tools/throws.ts',
        missing: 'tools/missing.ts',
        escapes: '../outside.ts',
      },
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
    const { tools, failed } = await loadTools(null, { project_tools: { lookup_order: 'tools/lookup.ts' } })
    expect(tools).toHaveLength(Object.keys(KORTIX_TOOLS).length)
    expect(failed).toEqual([{ name: 'lookup_order', error: 'this session has no project checkout to load it from' }])
  })

  test('an edited module is imported again on the next load', async () => {
    write('tools/v.ts', `export default { description: 'v', parameters: { type: 'object', properties: {} }, execute: () => 'one' }\n`)
    await loadTools(root, { project_tools: { v: 'tools/v.ts' } })
    expect(await runTool(hostedTool('v')!, {}, ctx())).toBe('one')
    write('tools/v.ts', `export default { description: 'v', parameters: { type: 'object', properties: {} }, execute: () => 'two' }\n`)
    const later = new Date(statSync(join(root, 'tools/v.ts')).mtimeMs + 5_000)
    utimesSync(join(root, 'tools/v.ts'), later, later)
    await loadTools(root, { project_tools: { v: 'tools/v.ts' } })
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
    // Owner-only: another user on the box cannot read a tool output.
    expect(statSync(file).mode & 0o777).toBe(0o600)
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

describe('the Kortix tools a project lists', () => {
  test('a Kortix tool the project does not list is not loaded; a listed one is', async () => {
    write('tools/lookup.ts', LOOKUP)
    await loadTools(root, { kortix_tools: ['web_search', 'image_search', 'scrape_webpage'], project_tools: { lookup_order: 'tools/lookup.ts' } })
    expect(hostedTool('show')).toBeUndefined()
    expect(hostedTool('scrape_webpage')?.name).toBe('scrape_webpage')
    expect(hostedTool('lookup_order')?.name).toBe('lookup_order')
  })
})
