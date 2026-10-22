/**
 * The two blocking interactions a turn can raise: a permission request before
 * a tool runs, and a question the agent asks the user. Both are Kortix types
 * (`RuntimePermissionRequest`, `RuntimeQuestionRequest`), answered over the
 * routes the product already calls (`/permission/:id/reply`,
 * `/question/:id/reply|reject`).
 */
import { randomUUID } from 'node:crypto'
import type {
  RuntimePermissionCapability,
  RuntimePermissionReply,
  RuntimePermissionRequest,
  RuntimeQuestion,
  RuntimeQuestionRequest,
  RuntimeToolRef,
} from '@kortix/api-contract/transcript'
import { comparePatterns } from '@kortix/api-contract/permission-rules'
import type { RuntimeFrame } from './transcript'

export type PermissionReply = RuntimePermissionReply

/** `allow` | `ask` | `deny` per tool name, `*` as the default. */
export type PermissionRule = 'allow' | 'ask' | 'deny'
/** OpenCode's `PermissionRuleConfig`: a bare action, or a glob-pattern -> action map. */
export type PermissionRuleConfig = PermissionRule | Record<string, PermissionRule>
export type PermissionPolicy = Record<string, PermissionRuleConfig>

const RULES = new Set(['allow', 'ask', 'deny'])
const isRule = (value: unknown): value is PermissionRule => typeof value === 'string' && RULES.has(value)

/**
 * Compile the manifest's compiled `permission` block (OpenCode's
 * PermissionConfig: `{ [tool]: 'allow'|'ask'|'deny' | { [pattern]: rule } }`).
 * Pattern maps are KEPT whole and matched per call by {@link resolveRule} —
 * collapsing them to their `*` entry would turn an explicit
 * `bash: { 'rm -rf *': 'deny', '*': 'allow' }` into an unconditional allow.
 * A tool with no rule is `allow`, OpenCode's default. A bare action
 * (`permission: deny`) is OpenCode's whole-agent form: it covers every tool.
 */
export function compilePermissionPolicy(raw: unknown): PermissionPolicy {
  const policy: PermissionPolicy = {}
  if (isRule(raw)) return { '*': raw }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return policy
  for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isRule(value)) policy[tool] = value
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const patterns: Record<string, PermissionRule> = {}
      for (const [pattern, rule] of Object.entries(value as Record<string, unknown>)) {
        if (isRule(rule)) patterns[pattern] = rule
      }
      if (Object.keys(patterns).length > 0) policy[tool] = patterns
    }
  }
  return policy
}

/**
 * OpenCode's `Wildcard.match` (`packages/opencode/src/util/wildcard.ts`):
 * backslashes normalise to `/`, `*` becomes `.*`, `?` becomes `.`, every other
 * regex metacharacter is escaped, and the whole pattern is anchored and
 * dot-all. A pattern ending in ` *` also matches the bare command, so `ls *`
 * covers a plain `ls`.
 */
export function wildcardMatch(value: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, 's').test(value.replaceAll('\\', '/'))
}

/**
 * The Kortix precedence (`@kortix/api-contract/permission-rules`): the most
 * specific matching pattern wins, whatever the authored order, so the
 * one-character `*` is the weakest entry in the map.
 */
function matchPatterns(subject: string, patterns: Record<string, PermissionRule>): PermissionRule | undefined {
  let matched: PermissionRule | undefined
  const sorted = Object.entries(patterns).sort(([a], [b]) => comparePatterns(a, b))
  for (const [pattern, rule] of sorted) {
    if (wildcardMatch(subject, pattern)) matched = rule
  }
  return matched
}

const RESERVED_PREFIX = /^(?:(?:if|then|elif|else|do|while|until|time|!|\{)\s+)+/
const RESERVED_ALONE = new Set(['fi', 'done', 'esac', '}'])

/**
 * The commands of a bash line, as OpenCode's tree-sitter walk asks about them:
 * the line splits on unquoted `;`, `&`, `|` and newlines (so `&&`, `||` and
 * `|&` too), and every `$(…)`, `` `…` ``, `<(…)`, `>(…)` and `( … )` body is
 * read as commands of its own. A command keeps its substitutions' text, as
 * OpenCode's does. `null` when the quotes or brackets do not balance.
 * ponytail: not a bash grammar — `case` arms and heredoc bodies read as
 * unbalanced or as extra commands, so they fail closed. Use tree-sitter-bash
 * when a manifest needs them exact.
 */
export function bashCommands(line: string): string[] | null {
  const commands: string[] = []
  // Reads from `start` up to `close` ('' = the end) and returns the index after it, or -1.
  const read = (start: number, close: string): number => {
    let piece = ''
    let quote = ''
    const flush = () => {
      const command = piece.trim().replace(RESERVED_PREFIX, '')
      // A `( … )` group is not a command: its body was read on its own.
      if (command && !RESERVED_ALONE.has(command) && !command.startsWith('(')) commands.push(command)
      piece = ''
    }
    let i = start
    while (i < line.length) {
      const ch = line[i]!
      if (quote === "'") {
        piece += ch
        if (ch === "'") quote = ''
        i++
        continue
      }
      if (ch === '\\') {
        piece += line.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === '"' || (ch === "'" && !quote)) {
        quote = quote ? '' : ch
        piece += ch
        i++
        continue
      }
      if (!quote && close && ch === close) {
        flush()
        return i + 1
      }
      if (ch === '`' || (ch === '(' && (!quote || line[i - 1] === '$'))) {
        const end = read(i + 1, ch === '`' ? '`' : ')')
        if (end < 0) return -1
        piece += line.slice(i, end)
        i = end
        continue
      }
      if (!quote && ch === ')') return -1
      // `2>&1`, `&>file` and `>|file` are redirections, not separators.
      const redirect = line[i - 1] === '>' || line[i - 1] === '<' || (ch === '&' && line[i + 1] === '>')
      if (!quote && (ch === ';' || ch === '\n' || ((ch === '&' || ch === '|') && !redirect))) {
        flush()
        i++
        continue
      }
      piece += ch
      i++
    }
    if (quote || close) return -1
    flush()
    return i
  }
  return read(0, '') < 0 ? null : commands
}

/**
 * The string a pattern is tested against, per tool — the subject OpenCode sends
 * as the permission request's pattern: the command line for `bash`, the skill
 * name for `skill`, the subagent name for `task`, the target path for the workspace tools.
 */
export function permissionSubject(tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const key = tool === 'bash' ? 'command' : tool === 'skill' ? 'name' : tool === 'task' ? 'subagent_type' : 'path'
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** Resolve one tool's rule for this call. `undefined` means "no rule applies". */
function resolveRule(config: PermissionRuleConfig | undefined, tool: string, args: unknown): PermissionRule | undefined {
  if (config === undefined || typeof config === 'string') return config
  const subject = permissionSubject(tool, args)
  if (subject !== undefined) return matchPatterns(subject, config)
  // No subject to test the specific patterns against. A restriction we cannot
  // evaluate must never silently degrade to `allow`.
  if (Object.entries(config).some(([pattern, rule]) => pattern !== '*' && rule !== 'allow')) return 'ask'
  return config['*']
}

/** pi's tools whose name is not their capability: `write` writes a file, which `edit` governs; the search and scrape tools reach the web. */
const TOOL_CAPABILITY: Record<string, RuntimePermissionCapability> = {
  write: 'edit',
  web_search: 'websearch',
  image_search: 'websearch',
  scrape_webpage: 'webfetch',
}

/**
 * The capability a permission rule names for this call (`RUNTIME_PERMISSION_CAPABILITIES`); any other tool is its own.
 * `memory` writes files under `memory/`: every command but `view` is an `edit`, so `edit: deny` stops it as it stops `write`.
 */
export function toolCapability(tool: string, args?: unknown): string {
  if (tool === 'memory') return (args as { command?: unknown } | null | undefined)?.command === 'view' ? 'read' : 'edit'
  return TOOL_CAPABILITY[tool] ?? tool
}

/**
 * One call's rule under `policy`. Every key that names the tool or its
 * capability (`*` and `pty_*` are patterns too) is tried most specific first;
 * the first that has a rule for this call decides, as OpenCode's last match
 * does over an ordered block. `undefined` means the policy says nothing.
 *
 * A bash line is decided command by command (`bashCommands`), as OpenCode
 * does, and the strictest answer wins: `allowed x; env` is the rule for `env`,
 * never the allowed prefix's. A line that does not parse is decided as a call
 * with no subject, so a restriction asks.
 */
export function resolvePolicyRule(policy: PermissionPolicy, tool: string, args: unknown): PermissionRule | undefined {
  const line = tool === 'bash' ? permissionSubject(tool, args) : undefined
  if (line === undefined) return resolveCall(policy, tool, args)
  const commands = bashCommands(line)
  if (commands === null) return resolveCall(policy, tool, {})
  if (commands.length === 0) return resolveCall(policy, tool, args)
  const rules = commands.map((command) => resolveCall(policy, tool, { ...(args as object), command }))
  return (['deny', 'ask', 'allow'] as const).find((rule) => rules.includes(rule))
}

function resolveCall(policy: PermissionPolicy, tool: string, args: unknown): PermissionRule | undefined {
  const names = [tool, toolCapability(tool, args)]
  const keys = Object.keys(policy)
    .filter((key) => names.some((name) => wildcardMatch(name, key)))
    .sort((a, b) => comparePatterns(b, a))
  for (const key of keys) {
    const rule = resolveRule(policy[key], tool, args)
    if (rule !== undefined) return rule
  }
  return undefined
}

/**
 * Whether an agent may see a skill. The manifest `skills:` grant compiles to
 * OpenCode's `permission.skill` rule; only a `deny` hides a skill. pi has no
 * skill tool to gate on load, so an `ask` skill stays listed.
 */
export function skillGranted(policy: PermissionPolicy, name: string): boolean {
  return resolvePolicyRule(policy, 'skill', { name }) !== 'deny'
}

export class PermissionBroker {
  private readonly pending = new Map<string, { request: RuntimePermissionRequest; resolve: (reply: PermissionReply) => void }>()
  private readonly alwaysAllowed = new Set<string>()

  constructor(
    private readonly sessionID: string,
    private readonly publish: (frame: RuntimeFrame) => void,
    private policy: PermissionPolicy = {},
    private readonly onAsked?: (request: RuntimePermissionRequest) => void,
  ) {}

  setPolicy(policy: PermissionPolicy): void {
    this.policy = policy
  }

  rule(tool: string, args?: unknown): PermissionRule {
    const resolved = resolvePolicyRule(this.policy, tool, args)
    // A deny outranks an earlier "always": approving `ls` must not unlock the
    // `rm -rf *` the same pattern map denies.
    if (resolved === 'deny') return 'deny'
    if (this.alwaysAllowed.has(toolCapability(tool, args))) return 'allow'
    return resolved ?? 'allow'
  }

  /** Resolves with the user's reply; never rejects. */
  ask(input: { tool: string; args: unknown; ref?: RuntimeToolRef }): Promise<PermissionReply> {
    const request: RuntimePermissionRequest = {
      id: `perm_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      sessionID: this.sessionID,
      // The capability, so "always" covers every tool that shares it (`write` and `edit`).
      permission: toolCapability(input.tool, input.args),
      patterns: [permissionSubject(input.tool, input.args) ?? '*'],
      metadata: input.args && typeof input.args === 'object' ? (input.args as Record<string, unknown>) : {},
      always: ['*'],
      ...(input.ref ? { tool: input.ref } : {}),
    }
    return new Promise<PermissionReply>((resolve) => {
      this.pending.set(request.id, { request, resolve })
      this.publish({ type: 'permission.asked', properties: { ...request } })
      this.onAsked?.(request)
    })
  }

  reply(id: string, reply: PermissionReply): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    if (reply === 'always') this.alwaysAllowed.add(entry.request.permission)
    this.publish({ type: 'permission.replied', properties: { sessionID: this.sessionID, requestID: id, reply } })
    entry.resolve(reply)
    return true
  }

  list(): RuntimePermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  /** A turn that ends (abort, error) releases every request it left open. */
  rejectAll(): void {
    for (const id of [...this.pending.keys()]) this.reply(id, 'reject')
  }
}

export class QuestionBroker {
  private readonly pending = new Map<string, { request: RuntimeQuestionRequest; resolve: (answers: string[][] | null) => void }>()

  constructor(
    private readonly sessionID: string,
    private readonly publish: (frame: RuntimeFrame) => void,
    private readonly onAsked?: (request: RuntimeQuestionRequest) => void,
  ) {}

  /** Resolves with the answers, or null when rejected; never rejects. */
  ask(questions: RuntimeQuestion[], ref?: RuntimeToolRef): Promise<string[][] | null> {
    const request: RuntimeQuestionRequest = {
      id: `que_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      sessionID: this.sessionID,
      questions,
      ...(ref ? { tool: ref } : {}),
    }
    return new Promise((resolve) => {
      this.pending.set(request.id, { request, resolve })
      this.publish({ type: 'question.asked', properties: { ...request } })
      this.onAsked?.(request)
    })
  }

  reply(id: string, answers: string[][]): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    this.publish({ type: 'question.replied', properties: { sessionID: this.sessionID, requestID: id, answers } })
    entry.resolve(answers)
    return true
  }

  reject(id: string): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    this.publish({ type: 'question.rejected', properties: { sessionID: this.sessionID, requestID: id } })
    entry.resolve(null)
    return true
  }

  list(): RuntimeQuestionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  rejectAll(): void {
    for (const id of [...this.pending.keys()]) this.reject(id)
  }
}
