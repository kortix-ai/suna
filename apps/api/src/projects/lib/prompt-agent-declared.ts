/**
 * Refuse a prompt that names an agent this project never declared.
 *
 * THE SANDBOX CAN CREATE AGENTS. A `.md` written into the working tree's
 * `.kortix/opencode/agents/` directory becomes a live, selectable agent the
 * next time opencode restarts. Verified on dev: a file that was never in git —
 * never read by the compiler, never in the config the API pushes — appeared in
 * `/agent` as `mode: primary` carrying the permissions its own frontmatter
 * declared, and the API accepted a turn as it (HTTP 204).
 *
 * `agentSwitchRefusal` could not catch that, and the reason is subtle: its
 * authorization branch only runs for a PROHIBITED SWITCH, and
 * `isProhibitedAgentSwitch` returns false whenever the session is bound to the
 * `default` sentinel — which is every session created without an explicit
 * agent, i.e. the common path. So the IAM check existed and was simply never
 * reached for the case that matters.
 *
 * This asks a different and much simpler question, one that does not depend on
 * what the session happens to be bound to:
 *
 *   > Is the requested name an agent this PROJECT declares?
 *
 * That matters beyond running one turn. Every per-agent control we have —
 * connector grants, the secrets `agent_scope` filter, Kortix CLI capabilities —
 * keys on agent identity. If the box can mint a name, those controls are
 * reasoning about an identity the box chose.
 *
 * DELIBERATELY NOT an authorization check. `authorize(PROJECT_AGENT_READ)`
 * already exists on the switch path; widening when it runs is a separate change
 * with its own blast radius. This closes the injection hole without touching
 * IAM semantics.
 */

import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { loadProjectAgents } from '../agents';

/** The sentinel a session carries when it is not bound to a concrete agent. */
const DEFAULT_AGENT_SENTINEL = 'default';

export type AgentDeclaredVerdict =
  | { ok: true }
  /** The project declares agents and this is not one of them. */
  | { ok: false; kind: 'undeclared'; agent: string; declared: string[] }
  /** We could not establish the declared set. Never treated as permission. */
  | { ok: false; kind: 'unresolved'; detail: string };

/**
 * Is `requestedAgent` declared by this project?
 *
 * Returns `ok` — meaning "nothing to refuse" — in three cases that are NOT
 * approval and must stay distinct from it:
 *   - no concrete agent was requested (null, or the `default` sentinel),
 *   - the project has no default branch, so there is no manifest to read,
 *   - the project declares no agents at all (a v1 `kortix.toml` project, or a
 *     v2 manifest with no `agents:` map). Inventing a policy for those would
 *     break every existing session to close a hole they do not have.
 *
 * A manifest we cannot READ is different from a manifest that declares nothing,
 * and is reported as `unresolved` so the caller can fail closed. Collapsing the
 * two would turn a transient git error into "any agent name is fine", which is
 * precisely the hole this exists to close.
 */
export async function checkPromptAgentDeclared(input: {
  projectId: string;
  requestedAgent: string | null;
}): Promise<AgentDeclaredVerdict> {
  const requested = input.requestedAgent?.trim();
  if (!requested || requested === DEFAULT_AGENT_SENTINEL) return { ok: true };

  let project: { repoUrl: string; defaultBranch: string | null; manifestPath: string | null } | undefined;
  try {
    [project] = await db
      .select({
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        manifestPath: projects.manifestPath,
      })
      .from(projects)
      .where(eq(projects.projectId, input.projectId))
      .limit(1);
  } catch (err) {
    return { ok: false, kind: 'unresolved', detail: errorText(err) };
  }

  if (!project?.defaultBranch || !project.repoUrl) return { ok: true };

  let declared: string[];
  try {
    // `rethrowReadErrors` is load-bearing, for the same reason it is in the
    // connector pre-flight: by default `loadProjectAgents` swallows an
    // unreadable manifest into a synthesized one, which here would read as
    // "this project declares nothing" — and a project that declares nothing is
    // one we let every agent name through. A read failure must reach the caller
    // as a failure, not as an empty declaration.
    const loaded = await loadProjectAgents(
      {
        projectId: input.projectId,
        repoUrl: project.repoUrl,
        defaultBranch: project.defaultBranch,
        manifestPath: project.manifestPath ?? 'kortix.yaml',
        gitAuthToken: null,
      },
      { rethrowReadErrors: true },
    );
    declared = loaded.specs.filter((spec) => spec.enabled).map((spec) => spec.name);
  } catch (err) {
    return { ok: false, kind: 'unresolved', detail: errorText(err) };
  }

  // No declared agents — a v1 project, or a v2 manifest without an `agents:`
  // map. There is no declared set to be outside of.
  if (declared.length === 0) return { ok: true };

  if (declared.includes(requested)) return { ok: true };
  return { ok: false, kind: 'undeclared', agent: requested, declared };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
