import { describe, expect, test } from 'bun:test'
import { PermissionBroker, compilePermissionPolicy } from '../harness/pi/interactions'

/**
 * A per-pattern rule (`bash: { 'rm -rf *': 'deny', '*': 'allow' }`) is a
 * first-class manifest form — `PermissionRuleV2` is "a bare action, or a
 * glob-pattern -> action map". Collapsing such a map to its `*` entry turned a
 * project's explicit deny into an unconditional allow on pi while OpenCode
 * still enforced it. These rows pin the matching to OpenCode's own wildcard
 * semantics: patterns sort by length then name, and the last match wins.
 * The runtime wiring (the tool call's args reach `rule()`) is proven in
 * pi-harness.test.ts.
 */
const broker = (policy: unknown) => new PermissionBroker('ses_test', () => {}, compilePermissionPolicy(policy))

describe('pi per-pattern permissions', () => {
  test.each([
    // The manifest example that motivated per-pattern rules.
    ['a per-pattern deny blocks the command it names', { bash: { 'rm -rf *': 'deny', '*': 'allow' } }, 'bash', { command: 'rm -rf /workspace' }, 'deny'],
    ['…and lets other commands through', { bash: { 'rm -rf *': 'deny', '*': 'allow' } }, 'bash', { command: 'ls -la' }, 'allow'],
    // Specificity, not severity, decides.
    ['a narrow allow stays above a broad deny', { bash: { 'git *': 'allow', '*': 'deny' } }, 'bash', { command: 'git status' }, 'allow'],
    ['the broad deny still covers the rest', { bash: { 'git *': 'allow', '*': 'deny' } }, 'bash', { command: 'curl https://example.com' }, 'deny'],
    // Insertion order differs from length order: the longest match still wins.
    ['the longest match wins (deny)', { bash: { 'git push *': 'deny', '*': 'allow', 'git *': 'ask' } }, 'bash', { command: 'git push origin main' }, 'deny'],
    ['the longest match wins (ask)', { bash: { 'git push *': 'deny', '*': 'allow', 'git *': 'ask' } }, 'bash', { command: 'git status' }, 'ask'],
    ['the longest match wins (allow)', { bash: { 'git push *': 'deny', '*': 'allow', 'git *': 'ask' } }, 'bash', { command: 'ls' }, 'allow'],
    // Equal length: the name order breaks the tie, not insertion order.
    ['an equal-length tie sorts by name', { bash: { 'git a*': 'deny', 'git *b': 'allow' } }, 'bash', { command: 'git ab' }, 'deny'],
    ['a trailing " *" covers the bare command', { bash: { 'ls *': 'deny', '*': 'allow' } }, 'bash', { command: 'ls' }, 'deny'],
    ['a trailing " *" covers arguments', { bash: { 'ls *': 'deny', '*': 'allow' } }, 'bash', { command: 'ls -la' }, 'deny'],
    ['workspace tools match on their path', { edit: { '*.env': 'deny', '*': 'allow' } }, 'edit', { path: 'apps/api/.env' }, 'deny'],
    ['…other paths fall to the default', { edit: { '*.env': 'deny', '*': 'allow' } }, 'edit', { path: 'apps/api/index.ts' }, 'allow'],
    ['"." is literal', { bash: { 'echo a.c': 'deny', '*': 'allow' } }, 'bash', { command: 'echo abc' }, 'allow'],
    ['"." matches itself', { bash: { 'echo a.c': 'deny', '*': 'allow' } }, 'bash', { command: 'echo a.c' }, 'deny'],
    ['"?" matches exactly one character', { bash: { 'echo a?c': 'deny', '*': 'allow' } }, 'bash', { command: 'echo abc' }, 'deny'],
    ['"?" never matches zero characters', { bash: { 'echo a?c': 'deny', '*': 'allow' } }, 'bash', { command: 'echo ac' }, 'allow'],
    // Security default: a restriction that cannot be evaluated asks.
    ['an unevaluatable restriction degrades to ask, never allow', { bash: { 'rm -rf *': 'deny', '*': 'allow' } }, 'bash', {}, 'ask'],
    ['a bare action applies to the tool', { bash: 'ask' }, 'bash', { command: 'ls' }, 'ask'],
    ['the "*" tool fallback applies', { '*': 'deny' }, 'bash', { command: 'ls' }, 'deny'],
    ['an empty policy allows, as OpenCode does', {}, 'bash', { command: 'ls' }, 'allow'],
    // An unknown action is dropped at compile time; nothing else restricts.
    ['an invalid action is dropped, not enforced', { bash: { 'rm -rf *': 'nonsense' } }, 'bash', { command: 'rm -rf /' }, 'allow'],
  ] as const)('%s', (_name, policy, tool, args, expected) => {
    expect(broker(policy).rule(tool, args)).toBe(expected)
  })

  test('a deny outranks an earlier "always" on the same tool', () => {
    const permissions = broker({ bash: { 'rm -rf *': 'deny', '*': 'ask' } })
    void permissions.ask({ tool: 'bash', args: { command: 'ls' } })
    permissions.reply(permissions.list()[0]!.id, 'always')
    expect(permissions.rule('bash', { command: 'ls' })).toBe('allow')
    expect(permissions.rule('bash', { command: 'rm -rf /' })).toBe('deny')
  })
})
