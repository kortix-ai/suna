import { describe, expect, test } from 'bun:test'
import { compilePermissionPolicy, resolvePolicyRule, toolCapability } from '@/harness/pi/interactions'

/**
 * Kortix guarantees one precedence: the most specific matching rule wins,
 * whatever order the keys are written in.
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

describe('the most specific rule wins, in any key order', () => {
  test.each(CASES)('%s', (_name, rules, tool, args, expected) => {
    expect(resolvePolicyRule(compilePermissionPolicy(rules), tool, args, '/workspace')).toBe(expected as never)
  })
})

/** The Kortix tools that write files in the checkout (`output/images/`, `memory/`). */
const WORKSPACE_WRITERS = ['image_gen', 'memory']

describe('`edit` governs every Kortix tool that writes the workspace', () => {
  test.each(WORKSPACE_WRITERS)('%s answers to `edit`', (tool) => {
    expect(toolCapability(tool, { command: 'create' })).toBe('edit')
    expect(resolvePolicyRule(compilePermissionPolicy({ edit: 'deny' }), tool, { command: 'create' }, '/workspace')).toBe('deny')
  })
})
