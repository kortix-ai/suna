/**
 * opencode must not load agents the platform never compiled.
 *
 * THE EXPLOIT THIS CLOSES, reproduced end to end on dev:
 *
 *   1. Restrict a project's agent through the supported API —
 *      `PUT /projects/<id>/agents/kortix/config` with `permission.bash = deny`.
 *   2. From inside the sandbox, write `.kortix/opencode/agents/<anything>.md`
 *      whose frontmatter declares `permission.bash = allow`.
 *   3. Restart opencode — which the agent can trigger itself.
 *   4. Both agents are now live in the same box:
 *        declared (kortix) : bash -> deny     what the project says
 *        injected          : bash -> allow    what the box says
 *
 * The box granted itself a capability the project denies. Per-agent permissions
 * were advisory against anything with file-write in the sandbox, which is every
 * agent.
 *
 * The API-side gate (prompt-agent-declared.ts) refuses an EXTERNAL caller who
 * names an undeclared agent, and it does not close this: opencode listens on
 * 127.0.0.1:4096 and the agent has a shell, so an in-box caller reaches its
 * self-granted agent without the API ever seeing the request. The only place
 * this can be stopped is where the agent files are read — here.
 *
 * WHAT COUNTS AS DECLARED is the compiled config the API hands down
 * (`KORTIX_COMPILED_AGENT_CONFIG`). It is compiled from the manifest at the
 * session's base ref, by a trusted service, and delivered sealed — so it is the
 * one description of the agent roster the sandbox cannot edit. Committing a
 * file on the session branch does not make it declared, which is the point.
 *
 * FILES ONLY. opencode's built-in agents (build, plan, explore, general, …) are
 * not files and are untouched — this prunes what the working tree contributes,
 * nothing else.
 */

import { readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { logger } from './logger'

/** Suffix given to a pruned file. Not `.md`, so opencode stops seeing it. */
const REJECTED_SUFFIX = '.rejected'

/**
 * The agent names the platform compiled, or `null` when we cannot tell.
 *
 * `null` means DO NOTHING, and the distinction is load-bearing in exactly the
 * way it is on the API side: a v1 `kortix.toml` project, a project whose
 * manifest declares no `agents:` map, and a config we failed to parse all
 * produce a roster we do not know. Pruning against an unknown roster would
 * delete every agent in the box — turning a config-delivery hiccup into a
 * session with no agents at all, which is far worse than the hole being closed.
 *
 * Fail-open here is deliberate and is only safe because it is paired with the
 * API-side refusal: an undeclared agent still cannot be reached from outside.
 */
export function declaredAgentNames(compiledAgentConfigRaw: string | undefined): Set<string> | null {
  if (!compiledAgentConfigRaw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(compiledAgentConfigRaw)
  } catch {
    logger.warn('[agents] compiled agent config is not valid JSON; not pruning')
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const agent = (parsed as { agent?: unknown }).agent
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null
  const names = Object.keys(agent as Record<string, unknown>)
  if (names.length === 0) return null
  return new Set(names)
}

export interface AgentPruneResult {
  /** Agent files left in place. */
  kept: string[]
  /** Agent files renamed out of the way. */
  rejected: string[]
  /** Files we failed to rename — still live, and logged as errors. */
  failed: string[]
}

/**
 * Rename every `agents/*.md` whose name the platform did not declare.
 *
 * Renamed rather than deleted: the content is evidence of what the box tried to
 * do, and destroying a user's file to enforce a policy is a worse default than
 * neutralizing it. The rename is in-place — a move to another directory could
 * cross a filesystem boundary and fail exactly when it matters.
 *
 * Runs on EVERY spawn, not once at boot. The attack needs a restart to take
 * effect, so the check has to sit on the same path the attack does.
 */
export function pruneUndeclaredAgentFiles(
  opencodeConfigDir: string,
  declared: Set<string> | null,
): AgentPruneResult {
  const empty: AgentPruneResult = { kept: [], rejected: [], failed: [] }
  if (!declared) return empty

  const agentsDir = join(opencodeConfigDir, 'agents')
  let entries: string[]
  try {
    entries = readdirSync(agentsDir)
  } catch {
    // No agents directory is normal — a project can define every agent through
    // the compiled config alone.
    return empty
  }

  const result: AgentPruneResult = { kept: [], rejected: [], failed: [] }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const name = entry.slice(0, -'.md'.length)
    if (declared.has(name)) {
      result.kept.push(name)
      continue
    }
    const from = join(agentsDir, entry)
    const to = `${from}${REJECTED_SUFFIX}`
    try {
      renameSync(from, to)
      result.rejected.push(name)
      logger.warn('[agents] refused an agent the platform never declared', {
        agent: name,
        file: from,
        renamedTo: to,
      })
    } catch (err) {
      result.failed.push(name)
      // Loud: the file is still there and opencode is about to load it.
      logger.error('[agents] could not neutralize an undeclared agent file', {
        agent: name,
        file: from,
        error: (err as Error).message,
      })
    }
  }
  return result
}
