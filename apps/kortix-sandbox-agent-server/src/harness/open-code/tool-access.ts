/**
 * An agent's tool access (`CompiledAgent.tools`, read with `toolAllowed`) as
 * OpenCode permission rules.
 *
 * OpenCode 1.18.23 hides a tool whose last matching rule is a deny on pattern
 * `*` (permission/index.ts `disabled`), and a rule matches by wildcard on the
 * permission name, the last match winning. Its own reading of an agent's
 * `tools` map does not keep Kortix's meaning: it turns `true` into `allow`
 * (an `ask` becomes `allow`), and the agent's `permission` is applied over
 * it, so a `bash: allow` there re-opened a `bash` the map removed. The
 * compiled map is therefore written as rules here, in order, and dropped:
 *
 *  - a removed tool: its rule moves to the end as `deny`;
 *  - an allowlist (`*: false`): `*: deny` first, then the agent's rules for
 *    allowed tools and for the permissions that are not tools, then each
 *    allowed tool without a rule at the action it had without the list.
 *
 * Kortix names reach OpenCode's: `bash` also covers the pty plugin's
 * `pty_*`; `write` and `apply_patch` share OpenCode's `edit` permission, so
 * an allowlist with either shows both and removing either removes both.
 */

/** OpenCode permission keys a Kortix tool name stands for. */
function permissionKeys(tool: string): string[] {
  if (tool === 'bash') return ['bash', 'pty_*']
  if (tool === 'write' || tool === 'apply_patch' || tool === 'patch') return ['edit']
  return [tool]
}

/** Permissions OpenCode asks that no tool is named after; an allowlist keeps their action. */
const NOT_TOOLS = ['external_directory', 'doom_loop']

type Rules = Record<string, unknown>

const asRules = (permission: unknown): Rules =>
  typeof permission === 'string'
    ? { '*': permission }
    : permission && typeof permission === 'object' && !Array.isArray(permission)
      ? { ...(permission as Rules) }
      : {}

/** The action a rule set gives `key` on its own, before any allowlist. */
function actionOf(rules: Rules, key: string): unknown {
  return Object.hasOwn(rules, key) ? rules[key] : rules['*']
}

export function toolAccessRules(tools: Record<string, boolean>, agentPermission: unknown, globalPermission: unknown): Rules {
  const own = asRules(agentPermission)
  if (tools['*'] !== false) {
    for (const [tool, enabled] of Object.entries(tools)) {
      if (enabled !== false) continue
      for (const key of permissionKeys(tool)) {
        delete own[key]
        own[key] = 'deny'
      }
    }
    return own
  }
  const global = asRules(globalPermission)
  const keep = [
    ...Object.entries(tools)
      .filter(([tool, enabled]) => tool !== '*' && enabled !== false)
      .flatMap(([tool]) => permissionKeys(tool)),
    ...NOT_TOOLS,
  ]
  const kept = (key: string) => keep.some((k) => k === key || (k.endsWith('*') && key.startsWith(k.slice(0, -1))))
  // `invalid` answers a call to a tool the model does not have; it is never offered to the model.
  const rules: Rules = { '*': 'deny', invalid: 'allow' }
  for (const [key, value] of Object.entries(own)) if (key !== '*' && kept(key)) rules[key] = value
  for (const key of keep) {
    if (Object.hasOwn(rules, key)) continue
    rules[key] = actionOf(own, key) ?? actionOf(global, key) ?? (NOT_TOOLS.includes(key) ? 'ask' : 'allow')
  }
  return rules
}

/** Apply every agent's compiled `tools` to its `permission`, in place, and drop `tools`. */
export function applyAgentToolAccess(config: Record<string, unknown>): void {
  const agents = config.agent
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return
  for (const entry of Object.values(agents as Record<string, Record<string, unknown>>)) {
    if (!entry || typeof entry !== 'object') continue
    const tools = entry.tools
    delete entry.tools
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) continue
    entry.permission = toolAccessRules(tools as Record<string, boolean>, entry.permission, config.permission)
  }
}
