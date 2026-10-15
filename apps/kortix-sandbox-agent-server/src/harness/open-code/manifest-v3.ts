/**
 * kortix.yaml v3 on OpenCode. The compiled set is the only input
 * (`KORTIX_COMPILED_AGENT_CONFIG` with `schema: 3`): this module turns its
 * Kortix-only keys (`skills`, `commands`, `extensions`, per-agent `extensions`
 * and `codemode`) into what OpenCode reads, and answers which agent may run a
 * command.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CompiledAgentSet } from '@kortix/api-contract/runtime-relay'
import { compiledSetV3 } from '@/lib/config/manifest-v3'
import { compiledAgentConfigFromEnv } from '@/services/config-provider/compiled-agent-config'
import { logger } from '@/lib/log/logger'

/** The v3 compiled set in `env`, or null for a v1/v2 session. */
export function compiledV3(env: NodeJS.ProcessEnv = process.env): CompiledAgentSet | null {
  return compiledSetV3(compiledAgentConfigFromEnv(env)) as CompiledAgentSet | null
}

/** A v3 set's commands (`{}` when it has none), or undefined for a v1/v2 session. */
export function v3Commands(env: NodeJS.ProcessEnv = process.env): NonNullable<CompiledAgentSet['commands']> | undefined {
  const set = compiledV3(env)
  return set ? (set.commands ?? {}) : undefined
}

/**
 * The process env that keeps OpenCode off project config for a v3 session:
 * no `opencode.json(c)` or `.opencode/` found upward from the working
 * directory, and no `.claude/skills` or `.agents/skills` discovery. Empty for
 * v1/v2, which keep OpenCode's discovery as it was.
 */
export function v3OpencodeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return compiledV3(env) ? { OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' } : {}
}

/** The agent a session boots with: `KORTIX_AGENT_NAME`, else the set's `default_agent`. */
export function sessionAgentName(set: CompiledAgentSet, env: NodeJS.ProcessEnv): string | null {
  const named = (env.KORTIX_AGENT_NAME ?? '').trim()
  return named && named !== 'default' ? named : (set.default_agent ?? null)
}

/**
 * Rewrite a v3 set into OpenCode config, in place: the Kortix-only keys go,
 * `commands` becomes `command`, and `skills.paths` / `plugin` get the
 * registered skill folders and the session agent's extensions under
 * `configRoot`. A folder or plugin file that does not exist is logged and
 * skipped; it never fails a boot.
 */
export function applyV3(out: Record<string, unknown>, set: CompiledAgentSet, env: NodeJS.ProcessEnv, configRoot: string | null): void {
  delete out.schema
  delete out.skills
  delete out.commands
  delete out.extensions
  for (const agent of Object.values((out.agent ?? {}) as Record<string, Record<string, unknown>>)) {
    delete agent.extensions
    delete agent.codemode
  }

  const commands = Object.entries(set.commands ?? {})
  if (commands.length > 0) {
    out.command = Object.fromEntries(
      commands.map(([name, command]) => [name, { template: command.template, ...(command.description ? { description: command.description } : {}) }]),
    )
  }

  if (!configRoot) return
  const existing = (label: string, path: string): string | null => {
    const full = join(configRoot, path)
    if (existsSync(full)) return full
    logger.warn(`[opencode] kortix.yaml ${label} not found; skipped`, { path: full })
    return null
  }

  // OpenCode scans `**/SKILL.md` under each path, the folder itself included:
  // a registered folder loads that skill and nothing beside it.
  const skillDirs = Object.entries(set.skills ?? {}).flatMap(([name, folder]) => existing(`skill "${name}"`, folder) ?? [])
  if (skillDirs.length > 0) out.skills = { paths: skillDirs }

  const agent = sessionAgentName(set, env)
  const plugins: string[] = []
  for (const name of (agent && set.agent?.[agent]?.extensions) || []) {
    const module = set.extensions?.[name]?.opencode
    if (!module) continue
    const file = existing(`extension "${name}"`, module)
    if (file) plugins.push(`file://${file}`)
  }
  if (plugins.length > 0) out.plugin = plugins
}

/** The `403` body for a `POST /session/:id/command` the agent may not run, or null when it may. */
export function commandRefusal(
  set: CompiledAgentSet,
  env: NodeJS.ProcessEnv,
  body: unknown,
): { error: 'command_not_enabled'; command: string; agent: string | null } | null {
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const command = typeof fields.command === 'string' ? fields.command : ''
  const agent = typeof fields.agent === 'string' && fields.agent.trim() ? fields.agent.trim() : sessionAgentName(set, env)
  if (agent && set.commands?.[command]?.agents.includes(agent)) return null
  return { error: 'command_not_enabled', command, agent }
}
