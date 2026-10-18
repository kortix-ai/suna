import type { RuntimePermissionCapability } from '@kortix/api-contract/transcript'
import { comparePatterns } from '@kortix/api-contract/permission-rules'

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
 */
export function resolvePolicyRule(policy: PermissionPolicy, tool: string, args: unknown): PermissionRule | undefined {
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

