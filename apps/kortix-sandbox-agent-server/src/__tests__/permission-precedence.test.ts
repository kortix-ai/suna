import { describe, expect, test } from 'bun:test'
import { bashCommands, compilePermissionPolicy, resolvePolicyRule, toolCapability } from '@/harness/pi/interactions'

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

describe('bashCommands reads heredocs and comments', () => {
  test.each([
    ['a quoted heredoc body is data', "cat <<'EOF' > notes.md\nit's done\nEOF\nls", ["cat <<'EOF' > notes.md", 'ls']],
    ['a <<- heredoc ends at a tab-indented delimiter', 'cat <<-EOF\n\tdon\'t\n\tEOF', ['cat <<-EOF']],
    ['an unquoted heredoc without substitutions is data', 'cat <<EOF\nit\'s fine\nEOF', ['cat <<EOF']],
    ["a comment's apostrophe is not a quote", "ls # don't list hidden\npwd", ['ls', 'pwd']],
    ['a # inside a word is not a comment', 'echo a#b', ['echo a#b']],
    ['a # inside quotes is not a comment', 'echo "# it\'s"', ['echo "# it\'s"']],
    ['a here-string is not a heredoc', 'grep x <<< "a b"', ['grep x <<< "a b"']],
  ])('%s', (_name, line, expected) => {
    expect(bashCommands(line)).toEqual(expected)
  })

  // bash expands `$(…)` and `` `…` `` in an unquoted heredoc body, so the body
  // stays commands: `rm *: deny` must still deny it, not ask.
  test.each([
    ['$(…)', 'cat <<EOF\n$(rm -rf /)\nEOF'],
    ['`…`', 'cat <<EOF\n`rm -rf /`\nEOF'],
  ])('an unquoted heredoc body that runs %s is decided as commands', (_name, line) => {
    expect(bashCommands(line)).toContain('rm -rf /')
    expect(resolvePolicyRule(compilePermissionPolicy({ bash: { '*': 'allow', 'rm *': 'deny' } }), 'bash', { command: line }, '/workspace')).toBe('deny')
  })

  // A body on an interpreter's stdin is code (Strix, PR #11850): it stays
  // commands, so `rm *: deny` still denies it.
  test.each([
    ['sh', "sh <<'EOF'\nrm -rf /\nEOF"],
    ['bash -s', "bash -s <<'EOF'\nrm -rf /\nEOF"],
    ['sudo bash <<-', "sudo bash <<-'EOF'\n\trm -rf /\n\tEOF"],
    ['| bash after the heredoc', "cat <<'EOF' | bash\nrm -rf /\nEOF"],
    ['/bin/sh', "/bin/sh <<'EOF'\nrm -rf /\nEOF"],
    ['env python3.12', "env python3.12 <<'EOF'\nrm -rf /\nEOF"],
    ['ssh', "ssh box <<'EOF'\nrm -rf /\nEOF"],
    ['source /dev/stdin', ". /dev/stdin <<'EOF'\nrm -rf /\nEOF"],
  ])('a heredoc on the stdin of %s is decided as commands', (_name, line) => {
    expect(resolvePolicyRule(compilePermissionPolicy({ bash: { '*': 'allow', 'rm *': 'deny' } }), 'bash', { command: line }, '/workspace')).toBe('deny')
  })

  // Quote removal joins the delimiter word (`<<'E'OF` is `EOF`). A word the
  // parser does not read whole is not a heredoc: its lines stay commands
  // (Strix, PR #11850).
  test.each([
    ["<<'E'OF", "cat <<'E'OF\nnotes\nEOF\nrm ./victim\nE"],
    ['<<"E"OF', 'cat <<"E"OF\nnotes\nEOF\nrm ./victim\nE'],
    ['<<E\\OF', 'cat <<E\\OF\nnotes\nEOF\nrm ./victim\nE'],
    ['<<E"OF"', 'cat <<E"OF"\nnotes\nEOF\nrm ./victim\nE'],
  ])('a split delimiter %s does not hide the commands after it', (_name, line) => {
    expect(resolvePolicyRule(compilePermissionPolicy({ bash: { '*': 'allow', 'rm *': 'deny' } }), 'bash', { command: line }, '/workspace')).toBe('deny')
  })

  // Any program can run its stdin, so a body is data only when every command
  // on its line is a known data reader; anything else keeps its lines as commands.
  test.each([
    ['$SHELL', "$SHELL <<'EOF'\nrm -rf /\nEOF"],
    ['a function defined on the line', "f(){ sh; }; f <<'EOF'\nrm -rf /\nEOF"],
    ['a script', "./run.sh <<'EOF'\nrm -rf /\nEOF"],
    ['sudo cat (a wrapper)', "sudo cat <<'EOF'\nrm -rf /\nEOF"],
    ['an escaped space before # (not a comment)', 'echo a\\ #; rm -rf /'],
    ['$((1<<2)) is no heredoc', 'echo $((1<<2))\nrm -rf /\n2'],
  ])('%s does not hide rm from a deny', (_name, line) => {
    expect(resolvePolicyRule(compilePermissionPolicy({ bash: { '*': 'allow', 'rm *': 'deny' } }), 'bash', { command: line }, '/workspace')).toBe('deny')
  })

  test.each([
    ['cat > "$OUT"', `cat > "$OUT" <<'EOF'\nit's\nEOF`],
    ['A=1 tee', "A=1 tee notes.md <<'EOF'\nit's\nEOF"],
    ['gh pr create --body-file -', "gh pr create --body-file - <<'EOF'\nit's done\nEOF"],
    ['git commit -F -', "git commit -F - <<'EOF'\ndon't\nEOF"],
  ])('a data reader (%s) keeps its body as data', (_name, line) => {
    expect(resolvePolicyRule(compilePermissionPolicy({ bash: { '*': 'allow', 'rm *': 'deny' } }), 'bash', { command: line }, '/workspace')).toBe('allow')
  })

  test.each([
    ['a heredoc with no delimiter line', "cat <<'EOF'\nit's"],
    ['an unbalanced quote', "echo 'it"],
  ])('%s does not parse', (_name, line) => {
    expect(bashCommands(line)).toBeNull()
  })
})

/**
 * A line that still does not parse is decided by the restricted patterns
 * that could match it: one whose first word appears in the line asks, else
 * the `*` rule decides. A deny pattern no longer turns every unparseable
 * command into a prompt that blocks an unattended session.
 */
const POLICY = { bash: { '*': 'allow', 'rm *': 'deny', 'git push *': 'ask' } }
describe('a bash line that does not parse', () => {
  test.each([
    ['no restricted word in the line: the `*` rule', "grep -oE \"x\" '([^']+)'", 'allow'],
    ['a restricted command name in the line asks', "echo 'x; rm -rf /", 'ask'],
    ['a restricted first word in the line asks', "git push origin 'main", 'ask'],
    ['the word inside another word does not count', "echo 'firmware", 'allow'],
  ])('%s', (_name, command, expected) => {
    expect(resolvePolicyRule(compilePermissionPolicy(POLICY), 'bash', { command }, '/workspace')).toBe(expected as never)
  })

  test('a pattern that starts with a wildcard asks', () => {
    const policy = compilePermissionPolicy({ bash: { '*': 'allow', '* --force': 'deny' } })
    expect(resolvePolicyRule(policy, 'bash', { command: "echo 'x" }, '/workspace')).toBe('ask')
  })

  test('a catch-all ask stays ask', () => {
    const policy = compilePermissionPolicy({ bash: { '*': 'ask', 'ls *': 'allow' } })
    expect(resolvePolicyRule(policy, 'bash', { command: "ls 'x" }, '/workspace')).toBe('ask')
  })
})
