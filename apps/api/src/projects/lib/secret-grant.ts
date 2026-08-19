/**
 * The ONE place a session's secret grant is resolved.
 *
 * Two paths inject project secrets into a sandbox — boot
 * (`buildSessionSandboxEnvVars`) and the per-prompt hot push
 * (`resolveOwnerRawEnv`). They used to duplicate this resolution, and the copies
 * drifted in two ways that both widened what an agent could read:
 *
 *   1. FAIL-OPEN. Both wrapped `loadProjectAgents` in `.catch(() => null)`, so
 *      any throw from the loader collapsed the grant to `undefined` — which
 *      `listProjectSecretsSnapshotForUser` reads as "all". A transient git/parse
 *      failure silently handed the agent every project secret. Resolution now
 *      throws `SecretGrantResolutionError` instead: a session that cannot prove
 *      what it is allowed to read gets nothing, loudly.
 *
 *   2. WRONG PRINCIPAL. The hot push resolved the grant from
 *      `project_sessions.agent_name` — the agent the session was CREATED with,
 *      a column nothing ever updates. But in-session agent switching is allowed
 *      (`preview.ts`: a prompt's `agent` field is forwarded untouched), so a
 *      session born under a broad agent could run a narrow one and still be
 *      handed the broad agent's full env. The grant is now resolved from the
 *      agent the prompt actually RUNS (`effectiveRunningAgent`), which replaces
 *      future secret delivery with that agent's grant.
 *
 * A switch is never REFUSED. It used to be, behind an operator flag, on the
 * argument that a later narrowing cannot un-read what the previous agent
 * already consumed. That is true, and it is exactly why refusing bought
 * nothing: the residue exists from the moment the first agent reads the value,
 * so blocking the second agent protects nothing still protectable. What the
 * refusal did instead was 409 ordinary switches — including through a call path
 * that hit the lock's `?? true` default while the flag was off. Re-scoping is
 * the whole mechanism now.
 *
 * The pure helpers below carry the policy; `resolveSessionSecretGrant` is the
 * single I/O entry point both call sites use.
 */

import type { AgentGrant } from '@kortix/db';
import {
  DEFAULT_AGENT_SENTINEL,
  type LoadedAgents,
  grantFromLoadedAgents,
  loadProjectAgents,
} from '../agents';

/**
 * The grant could not be resolved (manifest unreadable, loader threw). Callers
 * must NOT fall back to an unrestricted grant — that is the fail-open this
 * class exists to prevent. Boot surfaces it as a failed provision; the hot push
 * surfaces it as a failed prompt, which the proxy retries.
 */
export class SecretGrantResolutionError extends Error {
  constructor(
    readonly agentName: string,
    cause: unknown,
  ) {
    super(
      `could not resolve the secrets grant for agent '${agentName}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'SecretGrantResolutionError';
  }
}

/**
 * Which agent a prompt actually runs.
 *
 * The `'default'` sentinel is non-binding on the request side: the proxy strips
 * it from the body so OpenCode resolves its own `default_agent`, i.e. the agent
 * the session booted with. So it resolves to the session's own agent, NOT to a
 * fresh sentinel lookup — otherwise a session bound to a concrete agent would
 * have its grant recomputed against `'default'` on every ordinary turn.
 */
export function effectiveRunningAgent(
  requestedAgent: string | null | undefined,
  sessionAgent: string,
): string {
  const requested = requestedAgent?.trim();
  if (!requested || requested === DEFAULT_AGENT_SENTINEL) return sessionAgent;
  return requested;
}

/**
 * Normalized comparison key for a resolved grant's `env` list.
 *
 * `undefined` and `'all'` collapse to the SAME key: they are the same authority
 * everywhere it is actually applied — `resolveGrantedSecretEnv` (../secrets.ts)
 * computes `allowAll = grant === undefined || grant === 'all'` and the two take
 * an identical branch. They only differ in where they come from
 * (`grantFromLoadedAgents` returns null → `undefined` for an ungoverned project
 * or the non-binding `default` sentinel, and `'all'` for an agent that declares
 * `secrets: all` or omits the key). Treating them as distinct produced spurious
 * 409s on the most ordinary shape there is: a session bound to `default`
 * (→ `undefined`) sending a prompt naming a concrete agent that omits `secrets`
 * (→ `'all'`) — no privilege change whatsoever.
 *
 * An explicit list stays distinct from both, even one naming every secret today:
 * that is a DECLARED narrowing, and the secret set can change under it.
 */
function grantEnvKey(env: string[] | 'all' | undefined): string {
  if (env === undefined || env === 'all') return '*all*';
  return [...new Set(env.map((id) => id.toUpperCase()))].sort().join(',');
}

/** True when running `requestedAgent` instead of `sessionAgent` would change
 *  which secrets are in scope. Equal grants are a free switch. */
export function secretGrantEnvDiffers(
  sessionEnv: string[] | 'all' | undefined,
  requestedEnv: string[] | 'all' | undefined,
): boolean {
  return grantEnvKey(sessionEnv) !== grantEnvKey(requestedEnv);
}

/**
 * The same collapse for a grant's `connectors` / `kortixCli` lists.
 *
 * Deliberately NOT case-folded, unlike `grantEnvKey`. Each list is compared by
 * its own gate with an exact `includes()` (`agentMayUseConnector`,
 * `agentMayPerform`), so folding case here would call two lists equal that those
 * gates treat as different — and the whole point of this comparison is to
 * predict what those gates will do.
 */
function grantListKey(list: string[] | 'all' | undefined): string {
  if (list === undefined || list === 'all') return '*all*';
  return [...new Set(list)].sort().join(',');
}

/**
 * True when running `requestedAgent` instead of `sessionAgent` would change ANY
 * part of the authorization grant — secrets, connectors, or Kortix CLI actions.
 *
 * This is the RE-MINT predicate, not a refusal. A session's `agentGrant` is
 * written onto its token row ONCE, at mint (`account_tokens.agent_grant`), from
 * the agent the session was created with. Nothing re-mints it, and nothing
 * updates `project_sessions.agent_name` either — but a prompt may name a
 * different agent and the proxy forwards that untouched. So an agent reached by
 * SWITCHING ran with the boot agent's connector and CLI grants:
 *
 *     create session with agent A (connectors: all)
 *     prompt {"agent": "B"} where B declares connectors: [calendar]
 *       -> opencode runs B
 *       -> the token still carries A's grant
 *       -> B calls A's connectors, including ones its own manifest denies it
 *
 * The inverse is a functional bug rather than an escalation: a broad agent
 * reached from a narrow session gets 403 CONNECTOR_NOT_ASSIGNED with nothing in
 * the manifest to explain it.
 *
 * Why re-mint here where secrets REFUSE: a secret is already disclosed by the
 * time a switch is observed — it is in the box's tmpfs env file, in every shell
 * the previous agent spawned, and in its own context — so narrowing later
 * cannot un-read it. Connector and CLI grants are different: they are checked
 * against the token row at CALL time, so rewriting the row genuinely re-scopes
 * every subsequent call. Refusing those instead would 409 the most ordinary
 * manifest shape there is — per-agent `connectors:` with no `secrets:` declared
 * at all — on a switch the dashboard's own UI offers.
 */
export function agentGrantDiffers(
  sessionGrant: AgentGrant | null,
  requestedGrant: AgentGrant | null,
): boolean {
  return (
    secretGrantEnvDiffers(sessionGrant?.env, requestedGrant?.env) ||
    grantListKey(sessionGrant?.connectors) !== grantListKey(requestedGrant?.connectors) ||
    grantListKey(sessionGrant?.kortixCli) !== grantListKey(requestedGrant?.kortixCli)
  );
}

/**
 * Pure policy over an already-loaded manifest — exported for tests.
 *
 * The policy is now one rule: the env follows the agent that RUNS. The
 * session's create-time agent does not enter into it, which is why this takes
 * no `sessionAgent`. It cannot throw — a switch is always re-scoped, never
 * refused.
 */
export function secretGrantEnvForRunningAgent(
  loaded: LoadedAgents,
  runningAgent: string,
): string[] | 'all' | undefined {
  return grantFromLoadedAgents(runningAgent, loaded)?.env;
}

export interface SessionSecretGrantInput {
  projectId: string;
  repoUrl: string;
  /** Git context. Absent (a project with no default branch) means the manifest
   *  cannot be read at all, so there is no `agents:` map to narrow by and the
   *  grant is unrestricted — the documented back-compat path, NOT a failure. */
  defaultBranch: string | null | undefined;
  manifestPath: string | null | undefined;
  /** The agent this session is bound to (`project_sessions.agent_name`). */
  sessionAgent: string;
  /** The agent this prompt asked to run, when the caller is a prompt. Omit at
   *  boot — the session's own agent is the one that runs. */
  requestedAgent?: string | null;
  /** Bypass the process-local Git mirror TTL. Authorization paths set this so
   *  a manifest commit handled by another API replica applies on the next
   *  request, not up to 60 seconds later. */
  forceRefresh?: boolean;
}

/**
 * Resolve the `env` grant for the agent that will actually run.
 *
 * Throws `SecretGrantResolutionError` if the manifest cannot be loaded (fail
 * closed). A switch to an agent with a different grant is not an error — the
 * env is re-scoped onto the running agent.
 */
export async function resolveSessionSecretGrant(
  input: SessionSecretGrantInput,
): Promise<string[] | 'all' | undefined> {
  return (await loadGrantForRunningAgent(input)).env;
}

/**
 * The FULL grant of the agent a prompt will actually run — secrets, connectors
 * and Kortix CLI actions.
 *
 * Same resolution and same failure mode as `resolveSessionSecretGrant` (which
 * is this function's `env` leg): callers get `SecretGrantResolutionError` on an
 * unreadable manifest. The extra legs exist for the token re-mint, which needs
 * to know what the running agent may reach, not just what it may read.
 */
export async function resolveSessionAgentGrant(
  input: SessionSecretGrantInput,
): Promise<AgentGrant | null> {
  return (await loadGrantForRunningAgent(input)).grant;
}

async function loadGrantForRunningAgent(
  input: SessionSecretGrantInput,
): Promise<{ grant: AgentGrant | null; env: string[] | 'all' | undefined }> {
  if (!input.defaultBranch) return { grant: null, env: undefined };

  const runningAgent = effectiveRunningAgent(input.requestedAgent, input.sessionAgent);

  let loaded: LoadedAgents;
  try {
    // `rethrowReadErrors` is what makes this catch reachable AT ALL. By default
    // loadProjectAgents never throws: it swallows an unreadable manifest into a
    // SYNTHESIZED one that grants `secrets: 'all'`, and an unparseable one into
    // a result that resolves to unrestricted for the `default` sentinel. Either
    // would hand an ordinary prompt every project secret on a transient git
    // blip — the exact fail-open this module exists to close.
    loaded = await loadProjectAgents(
      {
        projectId: input.projectId,
        repoUrl: input.repoUrl,
        defaultBranch: input.defaultBranch,
        manifestPath: input.manifestPath ?? 'kortix.yaml',
        gitAuthToken: null,
      },
      { rethrowReadErrors: true, forceRefresh: input.forceRefresh },
    );
  } catch (err) {
    throw new SecretGrantResolutionError(runningAgent, err);
  }

  const env = secretGrantEnvForRunningAgent(loaded, runningAgent);
  return { grant: grantFromLoadedAgents(runningAgent, loaded), env };
}
