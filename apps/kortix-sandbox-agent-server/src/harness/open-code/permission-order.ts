import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The platform plugin that gives OpenCode the Kortix permission precedence:
 * the most specific rule wins, whatever order the keys are written in
 * (`@kortix/api-contract/permission-rules`). OpenCode applies the LAST
 * matching rule of a block in key order instead.
 *
 * kortixd orders the config it composes itself (`buildOpencodeConfigContent`).
 * The project's own `opencode.json[c]` and a config dir's `agents/*.md` reach
 * OpenCode without kortixd, and a deep merge keeps their key order, so only a
 * `config` hook, which receives the merged live config before any agent is
 * built (OpenCode 1.18.23 project/bootstrap.ts runs `plugin.init()` first), can
 * order every block. The source below is the same ordering as
 * `orderPermissionRules`; permission-precedence.test.ts proves they agree.
 */
/** @deprecated OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset". */
export const PERMISSION_ORDER_PLUGIN_SOURCE = `// Written by kortixd (harness/open-code/permission-order.ts). Do not edit.
const compare = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
const isMap = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
const sortKeys = (map) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => compare(a, b)))
const order = (permission) => {
  if (!isMap(permission)) return permission
  const out = sortKeys(permission)
  for (const [key, rule] of Object.entries(out)) if (isMap(rule)) out[key] = sortKeys(rule)
  return out
}

/** @deprecated OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset". */
export const KortixPermissionOrder = async () => ({
  config: async (config) => {
    if (isMap(config.permission)) config.permission = order(config.permission)
    for (const agent of Object.values(isMap(config.agent) ? config.agent : {})) {
      if (isMap(agent) && isMap(agent.permission)) agent.permission = order(agent.permission)
    }
  },
})
`

/**
 * Write the plugin beside the composed config, and return its `file://` spec.
 * @deprecated OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset".
 */
export function writePermissionOrderPlugin(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, PERMISSION_ORDER_PLUGIN_SOURCE, { mode: 0o644 })
  return `file://${path}`
}
