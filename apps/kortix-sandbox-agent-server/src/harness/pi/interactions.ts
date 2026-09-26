/**
 * The two blocking interactions a turn can raise: a permission request before
 * a tool runs, and a question the agent asks the user. Both are OpenCode wire
 * objects (`PermissionRequest`, `QuestionRequest`) answered over the same
 * routes the product already calls (`/permission/:id/reply`,
 * `/question/:id/reply|reject`, `/kortix/opencode/act`).
 */
import { randomUUID } from 'node:crypto'
import type { WireFrame } from './transcript'

export type PermissionReply = 'once' | 'always' | 'reject'

export interface PermissionRequestWire {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequestWire {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID: string; callID: string }
}

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
 * A tool with no rule is `allow`, OpenCode's default.
 */
export function compilePermissionPolicy(raw: unknown): PermissionPolicy {
  const policy: PermissionPolicy = {}
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
function wildcardMatch(value: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, 's').test(value.replaceAll('\\', '/'))
}

/**
 * OpenCode's `Wildcard.all`: patterns are sorted by length then name and the
 * LAST match wins, so the most specific pattern decides and the one-character
 * `*` is the weakest entry in the map.
 */
function matchPatterns(subject: string, patterns: Record<string, PermissionRule>): PermissionRule | undefined {
  let matched: PermissionRule | undefined
  const sorted = Object.entries(patterns).sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
  for (const [pattern, rule] of sorted) {
    if (wildcardMatch(subject, pattern)) matched = rule
  }
  return matched
}

/**
 * The string a pattern is tested against, per tool — the subject OpenCode sends
 * as the permission request's pattern: the command line for `bash`, the target
 * path for the workspace tools.
 */
export function permissionSubject(tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[tool === 'bash' ? 'command' : 'path']
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

export class PermissionBroker {
  private readonly pending = new Map<string, { request: PermissionRequestWire; resolve: (reply: PermissionReply) => void }>()
  private readonly alwaysAllowed = new Set<string>()

  constructor(
    private readonly sessionID: string,
    private readonly publish: (frame: WireFrame) => void,
    private policy: PermissionPolicy = {},
  ) {}

  setPolicy(policy: PermissionPolicy): void {
    this.policy = policy
  }

  rule(tool: string, args?: unknown): PermissionRule {
    const config = this.policy[tool] !== undefined ? this.policy[tool] : this.policy['*']
    const resolved = resolveRule(config, tool, args)
    // A deny outranks an earlier "always": approving `ls` must not unlock the
    // `rm -rf *` the same pattern map denies.
    if (resolved === 'deny') return 'deny'
    if (this.alwaysAllowed.has(tool)) return 'allow'
    return resolved ?? 'allow'
  }

  /** Resolves with the user's reply; never rejects. */
  ask(input: { tool: string; args: unknown; ref?: { messageID: string; callID: string } }): Promise<PermissionReply> {
    const request: PermissionRequestWire = {
      id: `perm_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      sessionID: this.sessionID,
      permission: input.tool,
      patterns: [input.tool],
      metadata: input.args && typeof input.args === 'object' ? (input.args as Record<string, unknown>) : {},
      always: [input.tool],
      ...(input.ref ? { tool: input.ref } : {}),
    }
    return new Promise<PermissionReply>((resolve) => {
      this.pending.set(request.id, { request, resolve })
      this.publish({ type: 'permission.asked', properties: { ...request } })
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

  list(): PermissionRequestWire[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  /** A turn that ends (abort, error) releases every request it left open. */
  rejectAll(): void {
    for (const id of [...this.pending.keys()]) this.reply(id, 'reject')
  }
}

export class QuestionBroker {
  private readonly pending = new Map<string, { request: QuestionRequestWire; resolve: (answers: string[][] | null) => void }>()

  constructor(
    private readonly sessionID: string,
    private readonly publish: (frame: WireFrame) => void,
    private readonly onAsked?: (request: QuestionRequestWire) => void,
  ) {}

  /** Resolves with the answers, or null when rejected; never rejects. */
  ask(questions: QuestionInfo[], ref?: { messageID: string; callID: string }): Promise<string[][] | null> {
    const request: QuestionRequestWire = {
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

  list(): QuestionRequestWire[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  rejectAll(): void {
    for (const id of [...this.pending.keys()]) this.reject(id)
  }
}
