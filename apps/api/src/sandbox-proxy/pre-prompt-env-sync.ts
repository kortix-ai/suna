/**
 * Everything that must happen BEFORE a turn-start body reaches opencode, split
 * out of `routes/preview.ts` so it can be imported WITHOUT evaluating the route.
 *
 * That split is load-bearing, not cosmetic. `routes/preview.ts` binds its
 * collaborators (`../projects/lib/sandbox-env-sync`, `session-token-grant`,
 * `opencode-session-snapshot`, `../../config`, `../backend`, `../../iam`, …) at
 * module-evaluation time, and every sibling proxy suite replaces exactly those
 * modules with `mock.module` before importing the route. Bun's module registry
 * is PROCESS-wide and a module evaluates once: any test file that imports
 * `routes/preview.ts` at top level caches the route with its REAL collaborators,
 * and every suite that runs after it in the same process silently gets the real
 * ones too — its `mock.module` stubs never take effect and its assertions stop
 * being able to fail. Measured: `preview-connector-required.test.ts` alone is
 * 13 pass / 0 fail; run after a file that imported the route it was 27 / 3, and
 * the three casualties were the Idempotency-Key-burn cases.
 *
 * So this module holds the pure predicates and the injectable turn-start block,
 * and imports NOTHING that a proxy suite mocks as a value:
 *  - the four collaborators are `import type` only (erased at runtime) and are
 *    passed in as `PrePromptEnvSyncDeps` — the real set lives in the route;
 *  - `secret-grant`, `session-token-grant` (the error classes) and
 *    `session-title-generate` (`extractPromptInfo`) are imported for real, and
 *    no proxy suite mocks any of them.
 *
 * `routes/preview.ts` re-exports the public names, so every existing import
 * path keeps working.
 */
import type { ProviderName } from '../platform/providers';
import type { syncSandboxEnvForPrompt } from '../projects/lib/sandbox-env-sync';
import { SecretGrantResolutionError } from '../projects/lib/secret-grant';
import {
  SessionGrantRemintError,
  type remintGrantForAgentSwitch,
} from '../projects/lib/session-token-grant';
import type { scheduleOpencodeSnapshotSync } from '../projects/opencode-session-snapshot';
import {
  extractPromptInfo,
  type generateSessionTitleFromFirstPrompt,
} from '../projects/session-title-generate';

/** One JSON error body with the proxy's CORS pair applied. Lives here rather
 *  than in the route because every refusal below builds one, and the route must
 *  not have to be evaluated to construct a response. */
export function jsonProxyError(
  body: Record<string, unknown>,
  status: number,
  origin?: string,
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback);
}

// The sentinel name a session carries when it isn't bound to a *concrete* agent.
// `project_sessions.agent_name` defaults to this, and no agent is literally named
// "default" — the runtime resolves it to OpenCode's configured `default_agent`
// (conventionally `kortix`). It is therefore non-binding: a "default" session's
// connector token carries the least-privileged grant (null = full for ungoverned
// projects, deny for governed ones — see `grantFromLoadedAgents`), so a prompt
// can never use it to escalate into another agent's connector / Kortix-CLI grant.
export const DEFAULT_AGENT_SENTINEL = 'default';

const RETRYABLE_ENV_SYNC_NETWORK_ERROR_RE =
  /\b(operation timed out|timeout|aborterror|unable to connect|connection refused|econnrefused|econnreset|socket hang up)\b/i;

function isRetryableEnvSyncFailure(message: string): boolean {
  if (/\benv sync failed: (502|503|504)\b/i.test(message)) return true;
  // Fetch rejections are bare network errors. HTTP failures include the daemon
  // response body, so don't classify a non-retryable status as transient just
  // because its JSON/body happens to mention a connection failure.
  if (/^env sync failed:/i.test(message)) return false;
  return RETRYABLE_ENV_SYNC_NETWORK_ERROR_RE.test(message);
}

/**
 * Should this request get the PRE-PROMPT project-env sync (and the small set of
 * turn-start side effects that hang off it)?
 *
 * THREE endpoints. `/command` is one of them, and it was missing until
 * 2026-08-12. `POST /session/:id/command` is opencode's blocking slash-command
 * endpoint: it creates a user message and runs a full agent turn, exactly like
 * `/message` does. Skipping the sync for it left two real holes:
 *
 *  - **Stale secrets.** A secret write propagates to live boxes through
 *    `propagateProjectSecretsToActiveSandboxes`, which is fire-and-forget and
 *    targets `status='active'` rows only. A box that was stopped at write time
 *    never receives it, so the per-turn sync is the ONLY self-heal. A session
 *    driven entirely by slash commands never healed.
 *  - **An unre-scoped agent switch.** A command body carries `agent` just like a
 *    prompt does. `agentSwitchRefusal` decides whether the caller MAY run that
 *    agent, but only this block re-resolves the secret grant for it
 *    (`syncSandboxEnvForPrompt`'s `requestedAgent`) and re-points the session
 *    token's connector/CLI grant at it (`remintGrantForAgentSwitch`). Without
 *    both, `/command` with `agent: B` ran B against agent A's env and A's grant.
 *
 * It is deliberately NOT the same list as `isNonIdempotentSessionWrite`, and the
 * two must not be merged back together — see the comment on that function. This
 * one answers "does this turn need its env re-scoped first?"; that one answers
 * "may the proxy send this body twice?".
 *
 * `/summarize` stays OUT even though `isTurnStartRequest` counts it. Compaction
 * carries no user prompt and no `agent` to re-scope for, and the sync is
 * fail-closed on a grant error — refusing to compact a conversation because a
 * manifest read failed would wedge a session instead of protecting it. Same
 * reasoning as `isConnectorGatedTurn`, which excludes it for the same reason.
 *
 * Pure + exported so the gate is unit-tested without provisioning a box — the
 * same reason `shouldAutoResumeStoppedSandbox` and `isProxiedBaseReset` are.
 */
export function shouldSyncProjectEnvBeforeProxy(
  port: number,
  method: string,
  path: string,
): boolean {
  if (port !== 8000) return false;
  if (method.toUpperCase() !== 'POST') return false;
  return /^\/session\/[^/]+\/(?:prompt_async|message|command)(?:$|[/?#])/.test(path);
}

/** The body's `agent` field, or null. Pure + exported so it is unit-tested
 *  against a real `/command` body without provisioning a box. */
export function requestedPromptAgent(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): string | null {
  if (!body) return null;
  const contentType = incomingHeaders.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      agent?: unknown;
    };
    return typeof parsed.agent === 'string' && parsed.agent.trim() ? parsed.agent.trim() : null;
  } catch {
    return null;
  }
}

// Drop the prompt's `agent` field entirely so OpenCode resolves its own
// `default_agent`. Used for non-concrete ('default') sessions: the box must
// always run the agent it booted with — the one the connector token was minted
// for — regardless of which concrete name the client speculatively echoed.
//
// Pure + exported so the rewrite is unit-tested on a real `/command` body — the
// rest of `{command, arguments, variant}` must survive it intact.
export function bodyWithoutPromptAgent(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): ArrayBuffer | undefined {
  if (!body) return body;
  const contentType = incomingHeaders.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return body;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      agent?: unknown;
    };
    if (!('agent' in parsed)) return body;
    parsed.agent = undefined;
    return new TextEncoder().encode(JSON.stringify(parsed)).buffer;
  } catch {
    return body;
  }
}

/**
 * Map a secret-grant failure from the pre-prompt env sync onto its response, or
 * null when the error is an ordinary env-sync failure the caller should handle
 * with its existing retry/502 logic.
 *
 * Every case refuses the prompt rather than forwarding it: the sandbox's env is
 * provisioned for ONE agent's grant, so a prompt we can't prove is entitled to
 * that env must not reach OpenCode. See projects/lib/secret-grant.ts.
 */
export function secretGrantErrorResponse(err: unknown, origin?: string): Response | null {
  // NOTE: no branch here returns 409. A prompt naming a different agent is
  // never refused — it is re-scoped. Every case below is "we could not APPLY
  // the re-scope", which is a 503 the client should retry, not a permanent
  // conflict the user must resolve by starting a new session.
  //
  // We could not establish what this agent may read. 503 rather than 502: the
  // sandbox is fine, our ability to VERIFY entitlement is what failed, and
  // retrying is the correct client response.
  // The switch was legal but we could not rewrite the token's grant to match the
  // agent now running. 503 for the same reason as above — and refusing is the
  // point: forwarding would run the new agent against the OLD agent's connector
  // and CLI grants, which is exactly the escalation the re-mint closes.
  if (err instanceof SessionGrantRemintError) {
    return jsonProxyError(
      { error: err.message, code: 'AGENT_SWITCH_GRANT_UNAPPLIED' },
      503,
      origin,
    );
  }
  if (err instanceof SecretGrantResolutionError) {
    return jsonProxyError(
      { error: err.message, code: 'AGENT_SECRET_GRANT_UNRESOLVED' },
      503,
      origin,
    );
  }
  return null;
}

/**
 * The collaborators `runPrePromptEnvSync` calls, injectable so the block can be
 * tested with plain fakes.
 *
 * DI rather than `mock.module`, deliberately: bun's `mock.module` is PROCESS-wide
 * and does not unwind at file boundaries, so a proxy test that stubbed `../backend`
 * silently blanked the real module for every sibling suite that ran after it in
 * the same process (4 unrelated `backend.test.ts` / `wake-deadline-guard.test.ts`
 * cases went red with `Received: 0` — their spies never fired). Passing the
 * collaborators in keeps the seam local to one call. Same pattern as
 * `scheduleOpencodeSnapshotSync`'s `options.loadRow ?? loadRow`.
 *
 * There is deliberately NO default value: a default would have to name the four
 * real modules here, and evaluating this file would then cache them before a
 * sibling suite's `mock.module` could replace them — the very contamination the
 * split exists to prevent. The REAL set is built in `routes/preview.ts`, which
 * every sibling re-evaluates under its own mocks.
 *
 * `extractPromptInfo` is deliberately NOT here. Whether a body yields prompt text
 * is the decision under test — a `/command` body has no `parts`, so it yields
 * none — and injecting it would test the fake instead of the rule.
 */
export interface PrePromptEnvSyncDeps {
  syncEnv: typeof syncSandboxEnvForPrompt;
  remintGrant: typeof remintGrantForAgentSwitch;
  scheduleSnapshot: typeof scheduleOpencodeSnapshotSync;
  generateTitle: typeof generateSessionTitleFromFirstPrompt;
}

/**
 * Everything that must happen BEFORE a turn-start body reaches opencode.
 *
 * Returns `null` to proceed with the forward, or the Response that REFUSES the
 * turn. A transient/retryable env-sync failure THROWS instead, so the caller's
 * wake-and-retry loop treats it exactly like any other sandbox reachability miss
 * — that control flow is load-bearing and unchanged by this extraction.
 *
 * Runs for `/prompt_async`, `/message` AND `/command` (see
 * `shouldSyncProjectEnvBeforeProxy`). The caller has already applied the
 * 'default'-sentinel body rewrite, so `body` here is what will be forwarded.
 */
export async function runPrePromptEnvSync(
  input: {
    record: {
      accountId: string;
      projectId: string;
      sessionId: string;
      externalId: string;
      agentName?: string | null;
      provider: string;
    };
    sandboxId: string;
    port: number;
    userId: string;
    origin: string;
    previewUrl: string;
    providerHeaders: Record<string, string>;
    serviceKey: string | null;
    /** The body's `agent`, read BEFORE the sentinel rewrite. */
    requestedAgent: string | null;
    body: ArrayBuffer | undefined;
    incomingHeaders: Headers;
  },
  deps: PrePromptEnvSyncDeps,
): Promise<Response | null> {
  const { record, sandboxId, port, userId, origin, requestedAgent } = input;
  const sessionAgent = record.agentName ?? DEFAULT_AGENT_SENTINEL;
  // A prompt is the one moment this sandbox is guaranteed awake, so off it we
  // (1) generate the Kortix-owned session title from this first prompt, using
  // the model the user picked, and (2) refresh the opencode_sessions snapshot
  // the conversation list reads. Both are fire-and-forget and never block the
  // prompt.
  //
  // A `/command` body is `{command, arguments, agent, model, variant}` and
  // carries no `parts`, so `extractPromptInfo` finds no text and the title is
  // SKIPPED — deliberately, not by accident. Titling a session
  // "/webapp build a site" would name it after the invocation rather than the
  // request, and feeding a raw command to the title model costs a completion for
  // a worse name than opencode's own. The snapshot refresh below still runs: a
  // command creates messages exactly like a prompt, so the conversation list is
  // just as stale after it.
  const prompt = extractPromptInfo(input.body, input.incomingHeaders);
  if (userId && prompt.text) {
    void deps.generateTitle({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
      firstPromptText: prompt.text,
      modelHint: prompt.model ?? undefined,
    });
  }
  deps.scheduleSnapshot({
    sessionId: record.sessionId,
    projectId: record.projectId,
    externalId: record.externalId,
  });
  try {
    await deps.syncEnv({
      projectId: record.projectId,
      sessionId: record.sessionId,
      externalId: record.externalId,
      serviceKey: input.serviceKey,
      previewUrl: input.previewUrl,
      providerHeaders: input.providerHeaders,
      providerName: record.provider as ProviderName,
      // The secret grant is resolved from the agent this prompt actually runs,
      // not the session's create-time column — see projects/lib/secret-grant.ts.
      requestedAgent,
    });
    // The env sync above applied the running agent's secret grant, or refused it
    // when the optional strict lock is enabled. Re-point the token's
    // connector/CLI grant at the agent that will actually run — it was frozen at
    // mint from the BOOT agent, and those gates read it at call time. Only on a
    // real switch: an ordinary turn resolves to the session's own agent and
    // skips the manifest read entirely.
    await deps.remintGrant({
      projectId: record.projectId,
      sessionId: record.sessionId,
      sessionAgent,
      requestedAgent,
    });
  } catch (err) {
    // Fail closed on anything to do with the secret grant: refuse the prompt
    // rather than forwarding it against an env we can't vouch for.
    const grantResponse = secretGrantErrorResponse(err, origin);
    if (grantResponse) {
      console.warn(
        `[PREVIEW] Secret grant refused prompt for ${sandboxId}:${port}: ${errorMessage(err, 'secret grant error')}`,
      );
      return grantResponse;
    }
    const message = errorMessage(err, 'project env sync failed');
    if (isRetryableEnvSyncFailure(message)) {
      // Treat daemon/preview-transient env-sync failures like any other
      // sandbox-port reachability miss: retry/wake in the outer loop, then
      // return the friendly port-unreachable response if the sandbox never
      // recovers. Throwing HTTPException here bypassed that retry path and
      // turned expected 502/timeouts from Daytona into Better Stack errors.
      throw new Error(message);
    }
    console.warn(`[PREVIEW] Project env sync failed for ${sandboxId}:${port}: ${message}`);
    return jsonProxyError({ error: message }, 502, origin);
  }
  return null;
}
