import { describe, expect, test } from 'bun:test'
import { PermissionBroker, compilePermissionPolicy } from '../harness/pi/interactions'

/**
 * A per-pattern rule (`bash: { 'rm -rf *': 'deny', '*': 'allow' }`) is a
 * first-class manifest form — `PermissionRuleV2` is "a bare action, or a
 * glob-pattern -> action map". Collapsing such a map to its `*` entry turned a
 * project's explicit deny into an unconditional allow on pi while OpenCode
 * still enforced it. These tests pin the matching to OpenCode's own semantics
 * (`packages/opencode/src/util/wildcard.ts`).
 */
const broker = (policy: unknown) => new PermissionBroker('ses_test', () => {}, compilePermissionPolicy(policy))

describe('pi per-pattern permissions', () => {
  test('a per-pattern deny blocks the command its pattern names', () => {
    const permissions = broker({ bash: { 'rm -rf *': 'deny', '*': 'allow' } })
    expect(permissions.rule('bash', { command: 'rm -rf /workspace' })).toBe('deny')
    expect(permissions.rule('bash', { command: 'ls -la' })).toBe('allow')
  })

  test('an allowlist keeps its narrow allow above the broad default', () => {
    const permissions = broker({ bash: { 'git *': 'allow', '*': 'deny' } })
    expect(permissions.rule('bash', { command: 'git status' })).toBe('allow')
    expect(permissions.rule('bash', { command: 'curl https://example.com' })).toBe('deny')
  })

  test('the longest matching pattern wins, as OpenCode sorts them', () => {
    const permissions = broker({ bash: { '*': 'allow', 'git *': 'ask', 'git push *': 'deny' } })
    expect(permissions.rule('bash', { command: 'git push origin main' })).toBe('deny')
    expect(permissions.rule('bash', { command: 'git status' })).toBe('ask')
    expect(permissions.rule('bash', { command: 'ls' })).toBe('allow')
  })

  test('a trailing " *" also covers the bare command', () => {
    const permissions = broker({ bash: { 'ls *': 'deny', '*': 'allow' } })
    expect(permissions.rule('bash', { command: 'ls' })).toBe('deny')
    expect(permissions.rule('bash', { command: 'ls -la' })).toBe('deny')
  })

  test('workspace tools match on their path argument', () => {
    const permissions = broker({ edit: { '*.env': 'deny', '*': 'allow' } })
    expect(permissions.rule('edit', { path: 'apps/api/.env' })).toBe('deny')
    expect(permissions.rule('edit', { path: 'apps/api/index.ts' })).toBe('allow')
  })

  test('a pattern is literal apart from * and ?', () => {
    const permissions = broker({ bash: { 'echo a.c': 'deny', '*': 'allow' } })
    expect(permissions.rule('bash', { command: 'echo abc' })).toBe('allow')
    expect(permissions.rule('bash', { command: 'echo a.c' })).toBe('deny')
  })

  test('an unevaluatable restriction degrades to ask, never to allow', () => {
    const permissions = broker({ bash: { 'rm -rf *': 'deny', '*': 'allow' } })
    expect(permissions.rule('bash', {})).toBe('ask')
  })

  test('a deny outranks an earlier "always" on the same tool', () => {
    const permissions = broker({ bash: { 'rm -rf *': 'deny', '*': 'ask' } })
    void permissions.ask({ tool: 'bash', args: { command: 'ls' } })
    permissions.reply(permissions.list()[0]!.id, 'always')
    expect(permissions.rule('bash', { command: 'ls' })).toBe('allow')
    expect(permissions.rule('bash', { command: 'rm -rf /' })).toBe('deny')
  })

  test('bare actions and the tool-name default still work', () => {
    expect(broker({ bash: 'ask' }).rule('bash', { command: 'ls' })).toBe('ask')
    expect(broker({ '*': 'deny' }).rule('bash', { command: 'ls' })).toBe('deny')
    expect(broker({}).rule('bash', { command: 'ls' })).toBe('allow')
  })

  test('the compiled policy keeps the pattern map for the agent object', () => {
    expect(compilePermissionPolicy({ bash: { 'rm -rf *': 'deny', '*': 'allow' } })).toEqual({
      bash: { 'rm -rf *': 'deny', '*': 'allow' },
    })
    expect(compilePermissionPolicy({ bash: { 'rm -rf *': 'nonsense' } })).toEqual({})
  })
})
