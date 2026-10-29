import { describe, expect, test } from 'bun:test'
import { orderPermissionRules } from '@kortix/api-contract/permission-rules'
import { buildOpencodeConfigContent } from '@/harness/open-code/lifecycle'
import { compilePermissionPolicy, permissionSubject, resolvePolicyRule, toolCapability } from '@/harness/pi/interactions'
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
})

/** The Kortix tools that write files in the checkout (`output/images/`, `memory/`). */
const WORKSPACE_WRITERS = ['image_gen', 'memory']

describe('`edit` governs every Kortix tool that writes the workspace, on both harnesses', () => {
  const compose = async (permission: Record<string, unknown>) => {
    const content = await buildOpencodeConfigContent({
      KORTIX_LLM_BASE_URL: 'http://gateway.test/v1',
      KORTIX_TOKEN: 'kortix_test_token',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { writer: { permission } } }),
    })
    const config = JSON.parse(content!) as { permission?: unknown; agent: { writer: { permission: unknown } } }
    return [config.permission, config.agent.writer.permission]
  }

  test.each(WORKSPACE_WRITERS)('OpenCode: an agent with `edit: deny` is denied %s', async (tool) => {
    expect(openCodeAction(await compose({ edit: 'deny' }), tool, '*')).toBe('deny')
  })

  test.each(WORKSPACE_WRITERS)('OpenCode: `edit: ask` denies %s, which cannot ask (fail closed)', async (tool) => {
    expect(openCodeAction(await compose({ edit: 'ask' }), tool, '*')).toBe('deny')
  })

  test.each(WORKSPACE_WRITERS)('OpenCode: `edit: allow` keeps %s, and its own rule wins', async (tool) => {
    expect(openCodeAction(await compose({ edit: 'allow' }), tool, '*')).toBe('allow')
    expect(openCodeAction(await compose({ edit: 'deny', [tool]: 'allow' }), tool, '*')).toBe('allow')
  })

  test.each(WORKSPACE_WRITERS)('pi: %s answers to `edit`', (tool) => {
    expect(toolCapability(tool, { command: 'create' })).toBe('edit')
    expect(resolvePolicyRule(compilePermissionPolicy({ edit: 'deny' }), tool, { command: 'create' }, '/workspace')).toBe('deny')
  })
})
