import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { orderPermissionRules } from '@kortix/api-contract/permission-rules'
import { buildOpencodeConfigContent } from '@/harness/open-code/lifecycle'
import { writePermissionOrderPlugin } from '@/harness/open-code/permission-order'
import { compilePermissionPolicy, permissionSubject, resolvePolicyRule } from '@/harness/pi/interactions'
import { openCodeAction } from './helpers/opencode-permission'

/**
 * Kortix guarantees one precedence on both harnesses: the most specific
 * matching rule wins, whatever order the keys are written in. pi resolves it
 * directly; OpenCode applies the last match in key order, so kortixd orders
 * every block first. Each row is evaluated both ways and must agree.
 */
const CASES: [string, Record<string, unknown>, string, Record<string, unknown>, string | undefined][] = [
  ['a trailing `*` does not override a specific bash rule', { bash: { 'git push *': 'ask', '*': 'allow' } }, 'bash', { command: 'git push origin main' }, 'ask'],
  ['…and still covers other commands', { bash: { 'git push *': 'ask', '*': 'allow' } }, 'bash', { command: 'ls -la' }, 'allow'],
  ['the prod skills shape: a listed skill loads', { skill: { 'aie-os': 'allow', '*': 'deny', 'customize-opencode': 'deny' } }, 'skill', { name: 'aie-os' }, 'allow'],
  ['…an unlisted skill is refused', { skill: { 'aie-os': 'allow', '*': 'deny', 'customize-opencode': 'deny' } }, 'skill', { name: 'pdf' }, 'deny'],
  ['a subagent allowlist with `*` last', { task: { reviewer: 'allow', '*': 'deny' } }, 'task', { subagent_type: 'reviewer' }, 'allow'],
  ['a tool key outranks a `*` key written after it', { bash: 'ask', '*': 'allow' }, 'bash', { command: 'ls' }, 'ask'],
  ['a `*` key covers a tool with no key', { bash: 'ask', '*': 'deny' }, 'read', { path: 'a.ts' }, 'deny'],
  ["a tool map with no match falls through to the `*` key", { bash: { 'git *': 'deny' }, '*': 'ask' }, 'bash', { command: 'ls' }, 'ask'],
  ['the longest of three patterns wins', { bash: { 'git push *': 'deny', '*': 'allow', 'git *': 'ask' } }, 'bash', { command: 'git push' }, 'deny'],
  ['an exact command outranks its glob', { bash: { 'git status': 'allow', 'git *': 'deny' } }, 'bash', { command: 'git status' }, 'allow'],
  ['an equal-length tie: the later in code-unit order wins', { bash: { 'git a*': 'deny', 'git *b': 'allow' } }, 'bash', { command: 'git ab' }, 'deny'],
  ['a file glob with `*` last', { edit: { '*.env': 'deny', '*': 'allow' } }, 'edit', { path: 'apps/api/.env' }, 'deny'],
  ['a narrow allow above a broad deny', { read: { 'docs/*': 'allow', '*': 'deny' } }, 'read', { path: 'docs/a.md' }, 'allow'],
]

describe('both harnesses resolve every rule the same way', () => {
  test.each(CASES)('%s', (_name, rules, tool, args, expected) => {
    const pi = resolvePolicyRule(compilePermissionPolicy(rules), tool, args, '/workspace')
    const openCode = openCodeAction([orderPermissionRules(rules)], tool, permissionSubject(tool, args, '/workspace')!)
    expect(pi).toBe(expected as never)
    expect(openCode).toBe(expected)
  })

  test('without ordering, OpenCode disagrees on the `*`-last rows (the bug class)', () => {
    const [, rules, tool, args] = CASES[0]!
    expect(openCodeAction([rules], tool, permissionSubject(tool, args, '/workspace')!)).toBe('allow')
  })
})

describe('the composed OpenCode config is ordered', () => {
  // A compiled config as an API without ordering sends it: `*` last in each block.
  const env: NodeJS.ProcessEnv = {
    KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({
      default_agent: 'a',
      agent: { a: { permission: { skill: { probe: 'allow', '*': 'deny' }, bash: { 'git push *': 'ask', '*': 'allow' }, '*': 'allow' } } },
    }),
  }

  test('global then agent block, OpenCode semantics: the specific rules win', async () => {
    const out = JSON.parse((await buildOpencodeConfigContent(env))!)
    const blocks = [out.permission, out.agent.a.permission]
    expect(openCodeAction(blocks, 'skill', 'probe')).toBe('allow')
    expect(openCodeAction(blocks, 'skill', 'other')).toBe('deny')
    expect(openCodeAction(blocks, 'skill', 'customize-opencode')).toBe('deny')
    expect(openCodeAction(blocks, 'bash', 'git push origin main')).toBe('ask')
    expect(openCodeAction(blocks, 'bash', 'ls')).toBe('allow')
  })

  test('the permission-order plugin is loaded when written', async () => {
    const out = JSON.parse((await buildOpencodeConfigContent(env, { permissionOrderSpec: 'file:///x/kortix-permission-order.js' }))!)
    expect(out.plugin).toEqual(['file:///x/kortix-permission-order.js'])
  })
})

describe('the permission-order plugin orders config kortixd did not compose', () => {
  test('its config hook orders the global and every agent block exactly as orderPermissionRules', async () => {
    const spec = writePermissionOrderPlugin(join(mkdtempSync(join(tmpdir(), 'kortix-perm-order-')), 'plugin.js'))
    const { KortixPermissionOrder } = await import(pathToFileURL(new URL(spec).pathname).href)
    const global = { bash: { 'git push *': 'ask', '*': 'allow' }, '*': 'ask', 'pty_*': 'deny' }
    const agent = { skill: { b: 'allow', a: 'allow', '*': 'deny' }, webfetch: 'deny' }
    const config = { permission: structuredClone(global), agent: { x: { permission: structuredClone(agent) }, y: { permission: 'allow' }, z: {} } }
    await (await KortixPermissionOrder()).config(config)
    expect(JSON.stringify(config.permission)).toBe(JSON.stringify(orderPermissionRules(global)))
    expect(JSON.stringify(config.agent.x.permission)).toBe(JSON.stringify(orderPermissionRules(agent)))
    expect(config.agent.y.permission).toBe('allow')
    expect(config.agent.z).toEqual({})
  })
})
