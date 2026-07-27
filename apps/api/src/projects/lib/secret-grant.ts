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
 *      agent the prompt actually RUNS (`effectiveRunningAgent`), and a switch
 *      that would cross a secret boundary is refused outright
 *      (`AgentSecretGrantMismatchError` → 409) because narrowing the env on a
 *      later turn cannot un-read what the previous agent already read: the
 *      secrets are in the box's tmpfs env file, in every shell it spawned, and
 *      in its own context.
 *
 * The pure helpers below carry the policy; `resolveSessionSecretGrant` is the
 * single I/O entry point both call sites use.
 */

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

/** A prompt asked to run an agent whose secret grant differs from the one this
 *  session's sandbox was provisioned for. */
export class AgentSecretGrantMismatchError extends Error {
  constructor(
    readonly sessionAgent: string,
    readonly requestedAgent: string,
  ) {
    super(
      `agent '${requestedAgent}' has a different secrets grant than this session's agent '${sessionAgent}'`,
    );
    this.name = 'AgentSecretGrantMismatchError';
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
 * Pure policy over an already-loaded manifest — exported for tests. Throws
 * `AgentSecretGrantMismatchError` when the switch crosses a secret boundary.
 *
 * `enforceGrantLock: false` is the operational kill switch. It degrades to
 * re-scoping the env onto the RUNNING agent's grant rather than reverting to
 * the old behavior of resolving from the session's stale create-time agent —
 * so turning enforcement off trades the hard refusal for a soft narrowing, it
 * never re-opens the original widening.
 */
export function secretGrantEnvForRunningAgent(
  loaded: LoadedAgents,
  sessionAgent: string,
  runningAgent: string,
  enforceGrantLock = true,
): string[] | 'all' | undefined {
  const runningEnv = grantFromLoadedAgents(runningAgent, loaded)?.env;
  if (runningAgent === sessionAgent) return runningEnv;

  const sessionEnv = grantFromLoadedAgents(sessionAgent, loaded)?.env;
  if (enforceGrantLock && secretGrantEnvDiffers(sessionEnv, runningEnv)) {
    throw new AgentSecretGrantMismatchError(sessionAgent, runningAgent);
  }
  return runningEnv;
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
  /** Operational kill switch for the grant-change refusal — see
   *  `secretGrantEnvForRunningAgent`. Defaults to enforced. */
  enforceGrantLock?: boolean;
}

/**
 * Resolve the `env` grant for the agent that will actually run.
 *
 * Throws `SecretGrantResolutionError` if the manifest cannot be loaded (fail
 * closed) and `AgentSecretGrantMismatchError` if the prompt's agent has a
 * different grant than the session's (fail closed on privilege change).
 */
export async function resolveSessionSecretGrant(
  input: SessionSecretGrantInput,
): Promise<string[] | 'all' | undefined> {
  if (!input.defaultBranch) return undefined;

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
      { rethrowReadErrors: true },
    );
  } catch (err) {
    throw new SecretGrantResolutionError(runningAgent, err);
  }

  return secretGrantEnvForRunningAgent(
    loaded,
    input.sessionAgent,
    runningAgent,
    input.enforceGrantLock ?? true,
  );
}
