/**
 * WHICH AGENT A SESSION RUNS when its manifest no longer declares the one it
 * was created with (docs/specs/config-releases.md, "Dropped agents").
 *
 * THE PROBLEM. `project_sessions.agent_name` is written at create and by
 * exactly one other writer (`repointSessionAgentToDeclaredDefault`, below).
 * A change request that removes or renames an agent leaves every session that
 * named it pointing at a name the manifest no longer declares. From that
 * moment:
 *
 *   - the `agent:<name>` release variant cannot compile — `compileSelectedAgentConfig`
 *     throws "Agent … is not declared", the builder returns
 *     `reason: 'compiled governance failed'` and `release_id: null`, and the box
 *     has no release to converge onto at all;
 *   - `grantFromLoadedAgents` default-denies the name, so the session's token
 *     carries no CLI actions, no connectors and no secrets.
 *
 * THE DECISION (Marko, 2026-09-24). RE-POINT, do not fake a grant. The session
 * becomes the project's declared default agent — audited, stated in the
 * session, and only when the session's owner may run that agent. A session
 * whose owner may not, or a project with no declared default, keeps no access
 * and is told why; it still receives a release, built from the `none` variant,
 * so it boots and can say so.
 *
 * WHY THIS DOES NOT WEAKEN INC-2026-09-15. That incident's rule is: an agent
 * name a project's own manifest does not declare NEVER receives anything.
 * `grantFromLoadedAgents` (`projects/agents.ts`) and `isLaunchableAgentName`
 * are untouched by this module and still deny-all such a name. Nothing here
 * grants an undeclared name anything. It changes which agent the session IS —
 * and only ever to a name the CURRENT manifest declares and enables, only
 * after an IAM check on the session's owner, and only by writing the column
 * every other path already reads. After the write the grant is resolved from a
 * declared name by the same unchanged resolver, exactly as if the session had
 * been created with it.
 *
 * The branch lives in this ONE pure resolver, which every path that builds a
 * release shares through `resolveDesiredRelease`. It is deliberately NOT at a
 * mint site: `remintGrantForAgentSwitch` re-resolves the running agent's grant
 * on every prompt and would erase a mint-local special case, which is the
 * 2026-08-13 platform-principal lesson.
 */

import { isMetaAgentName } from '@kortix/shared';
import { OPENCODE_BUILTIN_AGENT_NAMES } from '../projects/agents';
import type { ConfigReleaseVariant } from './builder';

/** The `default` sentinel: "whatever this project's default agent is". */
export const DEFAULT_AGENT_SENTINEL = 'default';

/** What the manifest declares at a release's source commit. */
export interface DeclaredAgentRoster {
  /** Declared AND enabled agent names. */
  enabled: readonly string[];
  /** The manifest's `default_agent`, only when it is itself declared and enabled. */
  defaultAgent: string | null;
  /** False when the manifest could not be read or parsed. Never decide on that. */
  readable: boolean;
  /** False when the project declares no agents at all — it adopted no governance. */
  governed: boolean;
}

export type SessionAgentDecision =
  /** The session keeps its agent. `agent` is null when the project has no default to resolve. */
  | { kind: 'declared'; agent: string | null }
  /** The manifest dropped `dropped`; `agent` is the declared default to re-point to. */
  | { kind: 'repoint'; agent: string; dropped: string }
  /** The manifest dropped `dropped` and there is no declared default to move to. */
  | { kind: 'orphaned'; dropped: string };

/**
 * PURE. `storedAgent` is `project_sessions.agent_name`.
 *
 * An unreadable manifest and an ungoverned project both answer "keep what you
 * have": neither is evidence that the agent was dropped, and a re-point is a
 * permanent write.
 */
export function resolveSessionReleaseAgent(
  storedAgent: string | null | undefined,
  roster: DeclaredAgentRoster,
): SessionAgentDecision {
  const name = (storedAgent ?? '').trim();

  // Never decide on a read that failed, and never on a project that declares
  // no agents — the same two conditions under which `grantFromLoadedAgents`
  // refuses to narrow.
  if (!roster.readable || !roster.governed) {
    return { kind: 'declared', agent: name || null };
  }

  // The sentinel is not an agent, it is "the project's default". Resolving it
  // is not a re-point: the column already says "whatever the default is", and
  // it keeps saying that when the default changes.
  if (!name || name === DEFAULT_AGENT_SENTINEL) {
    return { kind: 'declared', agent: roster.defaultAgent };
  }

  // The platform coordinator is injected, never declared (2026-08-13), and
  // OpenCode's own built-ins belong to the runtime, not to any manifest.
  // Neither was ever "dropped", so neither is ever re-pointed.
  if (isMetaAgentName(name) || OPENCODE_BUILTIN_AGENT_NAMES.has(name)) {
    return { kind: 'declared', agent: name };
  }

  if (roster.enabled.includes(name)) return { kind: 'declared', agent: name };

  const fallback = roster.defaultAgent;
  if (fallback && fallback !== name && roster.enabled.includes(fallback)) {
    return { kind: 'repoint', agent: fallback, dropped: name };
  }
  return { kind: 'orphaned', dropped: name };
}

/**
 * The release variant for the agent a session ends up running.
 *
 * `project` compiles every declared agent and is what a session with
 * repository access gets — it already holds the files. Without repository
 * access exactly one agent is compiled, so nothing else is disclosed.
 *
 * `none` is the answer for a session with no usable agent. It compiles to an
 * empty OpenCode config, whose etag is non-null, so `release_id` is never null
 * and the box always has a release to converge onto. It is NOT "the default
 * agent minus the grant": compiling the default agent for an owner who may not
 * run it would hand that owner the agent's prompt and model through the box.
 */
export function releaseVariantFor(agent: string | null, repositoryAccess: boolean): ConfigReleaseVariant {
  if (repositoryAccess) return 'project';
  return agent ? `agent:${agent}` : 'none';
}
