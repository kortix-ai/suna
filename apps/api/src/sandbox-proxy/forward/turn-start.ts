import { isWireIdAheadOf } from '../../services/sessions/wire-message-id';
import type { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { syncSandboxEnvForPrompt } from '../../services/sandboxes/sandbox-env-sync';
import { remintGrantForAgentSwitch } from '../../services/sessions/session-token-grant';
import { bindSessionTurnIdentity } from '../../projects/lib/on-behalf-of';
import { scheduleOpencodeSnapshotSync } from '../../services/sessions/opencode-session-snapshot';
import { generateSessionTitleFromFirstPrompt } from '../../services/sessions/session-title-generate';
import {
  convergeBeforeTurnStart,
  convergeModelCatalogForTurnStart,
  scheduleAssetConvergence,
} from '../../services/sessions/turn-start-convergence';
import {
  abandonSandboxTurn,
  acceptSandboxTurn,
  beginSandboxTurn,
} from '../../services/sandboxes/sandbox-turn-lifecycle';
import type { SandboxTurnIdentity } from '../../services/sessions/session-turn-ledger';
import { resolveSandboxIngress, type SandboxRecord } from '../backend';
import {
  DEFAULT_AGENT_SENTINEL,
  type PrePromptEnvSyncDeps,
  bodyWithoutPromptAgent,
  jsonProxyError,
  requestedPromptAgent,
  requestedPromptManagedModelId,
  runPrePromptEnvSync,
} from '../pre-prompt-env-sync';
import {
  PROMPT_TRANSCRIPT_READ_LIMIT,
  WIRE_ID_PLACED_HEADER,
  isPromptWireIdRepairPath,
  promptBodyMessageId,
  promptTranscriptReadPath,
  readNewestWireIdTime,
  repairPromptWireId,
} from '../prompt-wire-id-repair';
import {
  claimPromptDelivery,
  deliveryKeyIdentifiesOneSubmission,
  promptDeliveryKey,
  releasePromptDelivery,
} from '../prompt-dedupe';
import { recordSessionActivity } from '../../services/sessions/session-activity';
import type { ForwardRequest, ForwardState } from './context';

// Turn-start preparation on the forward path: runtime convergence before the
// prompt, the pre-prompt env sync, wire-id placement, and the durable
// turn-lifecycle record around the upstream delivery.

// The REAL collaborators for the pre-prompt turn-start block. Built HERE, not in
// ../pre-prompt-env-sync.ts: this module is re-evaluated by every proxy suite
// under its own `mock.module` stubs, so binding the five modules here is what
// keeps those stubs effective. Binding them in the extracted module instead
// would cache the real ones for the whole process the first time any test
// touched it.
const REAL_PRE_PROMPT_DEPS: PrePromptEnvSyncDeps = {
  syncEnv: syncSandboxEnvForPrompt,
  remintGrant: remintGrantForAgentSwitch,
  bindTurnIdentity: bindSessionTurnIdentity,
  scheduleSnapshot: scheduleOpencodeSnapshotSync,
  generateTitle: generateSessionTitleFromFirstPrompt,
};

export interface TurnLifecycle {
  begin(): Promise<'granted' | 'unavailable'>;
  accept(): Promise<void>;
  abandon(): Promise<void>;
}

// `deadline_at` is the idle-stop clock. This separate record is the durable
// fact that a specific OpenCode turn is active. It is created immediately
// before the first upstream delivery attempt, promoted only after a confirmed
// or ambiguous acceptance, and removed by matching terminal evidence.
export function createTurnLifecycle(
  sandboxId: string,
  turnIdentity: SandboxTurnIdentity | null,
): TurnLifecycle {
  const turnToken = turnIdentity ? crypto.randomUUID() : null;
  let turnLifecycleBegun = false;
  let turnLifecycleAccepted = false;
  const beginTurnLifecycle = async (): Promise<'granted' | 'unavailable'> => {
    if (!turnIdentity || !turnToken || turnLifecycleBegun) return 'granted';
    try {
      const outcome = await beginSandboxTurn(
        { externalId: sandboxId },
        { token: turnToken, ...turnIdentity },
      );
      turnLifecycleBegun = outcome === 'granted';
      return outcome === 'no_box' ? 'unavailable' : outcome;
    } catch (error) {
      console.error(
        `[turn-lifecycle] refused prompt for ${sandboxId}: delivery authority is unavailable`,
        error,
      );
      return 'unavailable';
    }
  };
  const acceptTurnLifecycle = async (): Promise<void> => {
    if (!turnLifecycleBegun || !turnToken || turnLifecycleAccepted) return;
    try {
      turnLifecycleAccepted = await acceptSandboxTurn({ externalId: sandboxId }, turnToken);
    } catch (error) {
      // OpenCode already accepted this non-idempotent request. Do not convert a
      // post-delivery database outage into a failed send or delete the durable
      // `delivering` record. The provider-neutral reaper probes that exact
      // token-bound record and promotes it when OpenCode reports the turn live.
      console.error(
        `[turn-lifecycle] acceptance persistence failed for ${sandboxId}; reaper will reconcile delivery`,
        error,
      );
    }
  };
  const abandonTurnLifecycle = async (): Promise<void> => {
    if (!turnLifecycleBegun || !turnToken || turnLifecycleAccepted) return;
    try {
      await abandonSandboxTurn({ externalId: sandboxId }, turnToken);
      turnLifecycleBegun = false;
    } catch (error) {
      // Cleanup failure must not replace the upstream response. The durable
      // delivery record expires through the reaper's exact-message probe.
      console.error(
        `[turn-lifecycle] delivery cleanup failed for ${sandboxId}; reaper will reconcile delivery`,
        error,
      );
    }
  };
  return { begin: beginTurnLifecycle, accept: acceptTurnLifecycle, abandon: abandonTurnLifecycle };
}

/**
 * Claim the dedupe key of a turn-creating POST before the retry loop, and stamp
 * the session's last activity. Returns the claimed key (null when the request
 * is not claimable), or the `duplicate` response for a repeat submission.
 */
export function claimPromptDeliveryOnce(input: {
  promptDelivery: boolean;
  incomingHeaders: Headers;
  sandboxId: string;
  record: SandboxRecord;
  requestBody: ArrayBuffer | undefined;
  origin: string;
}): { promptDedupeKey: string | null } | { response: Response } {
  const { promptDelivery, incomingHeaders, sandboxId, record, requestBody, origin } = input;
  // Dedupe OpenCode prompt delivery up-front. Claim a stable key before the retry
  // loop so a duplicate inbound prompt cannot enqueue the user message twice.
  //
  // The key is held in an OUTER binding so the give-up path below can release it
  // when delivery provably never happened. Without that release, a client retry
  // under the same Idempotency-Key hits the bogus 200 "duplicate" and the user's
  // prompt is silently lost.
  let promptDedupeKey: string | null = null;
  const idempotencyKey = incomingHeaders.get('idempotency-key');
  // Non-idempotent (never re-sent by us) and dedupe-claimed (a later lookalike
  // is short-circuited) are DIFFERENT guarantees — see
  // `deliveryKeyIdentifiesOneSubmission`. A body with no client-unique field
  // yields a content hash, and claiming on that silently swallows a deliberate
  // re-send: the same sentence, the same command, the same /compact.
  if (promptDelivery) {
    const key = promptDeliveryKey({
      idempotencyKey,
      sandboxId,
      sessionId: record.sessionId,
      body: requestBody,
    });
    if (deliveryKeyIdentifiesOneSubmission(key)) {
      promptDedupeKey = key;
      if (!claimPromptDelivery(key)) {
        return { response: jsonProxyError({ status: 'duplicate', deduplicated: true }, 200, origin) };
      }
    }
    // Stamped for EVERY turn-creating POST, claimed or not: a prompt the proxy
    // cannot dedupe is still the user acting on this session. Past the claim,
    // so a re-sent prompt cannot double-count, and outside the retry loop
    // below, so a wake retry cannot either. This is the sidebar's authoritative
    // "last activity" — unlike the opencode_sessions snapshot scheduled further
    // down, it needs no sandbox round-trip, so a session stays correctly dated
    // even when the box is unreachable. See services/sessions/session-activity.ts.
    void recordSessionActivity({
      sessionId: record.sessionId,
      projectId: record.projectId,
    });
  }
  return { promptDedupeKey };
}

/**
 * C9: converge a box that is behind before a user turn runs on it, and start
 * the first attempt's ingress resolve alongside. `refusal` is set when the
 * model-catalog repair definitively did not land.
 */
export async function convergeTurnStartRuntime(input: {
  record: SandboxRecord;
  ingressRequest: ForwardRequest['ingressRequest'];
  isSseEventStreamRequest: boolean;
  requestBody: ArrayBuffer | undefined;
  incomingHeaders: Headers;
  ptl: ProvisionTimeline;
  origin: string;
}): Promise<{
  prefetchedIngress: ReturnType<typeof resolveSandboxIngress> | null;
  refusal: Response | null;
}> {
  const { record, ingressRequest, isSseEventStreamRequest, requestBody, incomingHeaders, ptl, origin } = input;
  let prefetchedIngress: ReturnType<typeof resolveSandboxIngress> | null = null;
  // R2 — config-converge, model-catalog-converge and the ingress resolve
  // read/act on three independent surfaces (the session's config release,
  // the box's managed-model map, this box's provider network address) and
  // none consumes another's result before the upstream fetch is built. They
  // used to run back to back — measured ~40 ms each on a warm box, ~120 ms
  // stacked for nothing. They now start together and are joined where each
  // result is first actually needed, exactly like `Promise.all` on the
  // pre-flight reads the spec calls out (§3, R2).
  //
  // EXCLUDED: the SSE stall-recovery path just below
  // (`isSseEventStreamRequest`) decides whether to INVALIDATE the cached
  // ingress link before ever resolving it; starting the resolve here would
  // race that decision and could hand the stream the exact stale link the
  // invalidation exists to discard. That path is a `GET /global/event`,
  // never a prompt — this exclusion never touches the send-a-prompt path
  // the latency budget is about.
  if (!isSseEventStreamRequest) {
    prefetchedIngress = resolveSandboxIngress(record, ingressRequest);
    // Never let an error here become an unhandled rejection if the request
    // returns before the retry loop consumes it (e.g. an agent-switch or
    // model-catalog refusal below) — the loop's own resolve, or nothing,
    // takes over in that case.
    prefetchedIngress.catch(() => undefined);
  }
  const requestedModelId = requestedPromptManagedModelId(requestBody, incomingHeaders);
  const convergedPromise = convergeBeforeTurnStart(record.sessionId);
  const modelCatalogPromise = convergeModelCatalogForTurnStart(record.sessionId, requestedModelId);

  const converged = await convergedPromise;
  ptl.mark('config-converge');
  // …and the BINARIES, which must not block. `convergeBeforeTurnStart` above
  // awaits because config changes what the agent IS; the daemon, the CLI, the
  // overlay and OpenCode are ~96 MB / ~104 MB / ~373 KB / ~167 MB and a box
  // one turn behind on them is the state that exists today. This call returns
  // synchronously, never throws, and adds no network call at all to a box the
  // API last saw current — it reads two in-process maps, and its only probe is
  // the health GET the gate above already made. Do not await it.
  scheduleAssetConvergence(record.sessionId);
  if (converged.decision !== 'current' && converged.decision !== 'skipped') {
    console.log('[PREVIEW] turn-start config convergence', {
      session_id: record.sessionId,
      decision: converged.decision,
      outcome: converged.outcome,
      ms: converged.ms,
    });
  }
  // A third case, neither CONFIG nor BINARIES: the box's `kortix` provider
  // map is missing the ONE model this turn asks for. AWAITED — unlike the
  // asset lane just above — because the alternative is `Model not found:
  // kortix/<id>` while the control plane serves that model the whole time
  // (2026-09-26). Any provider: a `codex/…` or BYOK id the box's image
  // catalog predates fails the same way (2026-10-01, codex/gpt-6.1-sol).
  // A model the box already confirmed costs one in-process map read.
  const modelCatalog = await modelCatalogPromise;
  ptl.mark('model-catalog-converge');
  if (modelCatalog.decision !== 'skipped' && modelCatalog.decision !== 'current') {
    console.log('[PREVIEW] turn-start model-catalog convergence', {
      session_id: record.sessionId,
      decision: modelCatalog.decision,
      daemon_outcome: modelCatalog.daemonOutcome,
      model: requestedModelId,
    });
  }
  // The repair was attempted and DEFINITIVELY did not land for the process
  // about to answer this turn — `declined` (a turn was live, or the
  // verified swap did not boot) or `no-gateway` (the box could not even
  // fetch the live lineup). Forwarding anyway is a guaranteed OpenCode
  // `500 UnknownError` with no cause named (2026-09-26: reproduced three
  // times, different opaque refs, no signal a client or an operator could
  // act on). Refuse HERE instead, with the one fact that actually explains
  // it — the model, and why the repair could not confirm it — so the
  // client can retry (the box may already be fixed for its NEXT natural
  // restart) instead of being told nothing.
  if (
    modelCatalog.decision === 'converged' &&
    (modelCatalog.daemonOutcome === 'declined' || modelCatalog.daemonOutcome === 'no-gateway')
  ) {
    return {
      prefetchedIngress,
      refusal: jsonProxyError(
        {
          error: `This session's runtime could not confirm model "${requestedModelId}" for this turn`,
          code: 'MODEL_CATALOG_UNCONFIRMED',
          model: requestedModelId,
          daemon_outcome: modelCatalog.daemonOutcome,
          retry: true,
        },
        503,
        origin,
      ),
    };
  }
  return { prefetchedIngress, refusal: null };
}

/**
 * The pre-prompt env sync for one attempt (secrets, grant re-mint, turn
 * identity). Returns the refusal to send, or null to continue. May rewrite
 * `state.requestBody`.
 */
export async function syncEnvBeforeTurnStart(
  req: ForwardRequest,
  state: ForwardState,
  previewUrl: string,
  providerHeaders: Record<string, string>,
): Promise<Response | null> {
  const { record, sandboxId, port, userId, origin, serviceKey, access, incomingHeaders, promptDedupeKey } = req;
  const requestedAgent = requestedPromptAgent(state.requestBody, incomingHeaders);
  // Authorization runs before the dedupe claim. Drop only the legacy
  // 'default' sentinel so OpenCode resolves its own `default_agent` (the
  // real default the session booted with). A *concrete* requested agent
  // stays on the authorized switch path: the caller's grant decides, and
  // the pre-prompt env sync re-scopes box and token to that agent.
  if (requestedAgent === DEFAULT_AGENT_SENTINEL) {
    state.requestBody = bodyWithoutPromptAgent(state.requestBody, incomingHeaders);
  }
  const refusal = await runPrePromptEnvSync(
    {
      record,
      sandboxId,
      port,
      userId,
      origin,
      previewUrl,
      providerHeaders,
      serviceKey,
      requestedAgent,
      bindTurnIdentity: access.kind === 'principal' && access.bindTurnIdentity === true,
      body: state.requestBody,
      incomingHeaders,
    },
    REAL_PRE_PROMPT_DEPS,
  );
  if (refusal) {
    // The refusal was raised BELOW `claimPromptDelivery`, so returning it
    // as-is burns the caller's Idempotency-Key: their retry — the exact
    // thing a 503 tells them to make — would come back
    // `200 {"deduplicated":true}` and the message would be silently lost.
    //
    // Safe by construction: `runPrePromptEnvSync` talks to the DAEMON's
    // /kortix/env, never to opencode's session endpoints, and it runs
    // strictly before the upstream fetch — so nothing was delivered and a
    // re-delivery cannot double-enqueue. `promptDeliveryMayHaveReachedUpstream`
    // keeps that honest for the one path that could contradict it: a retry
    // attempt whose PREVIOUS attempt already fetched. Then the failure is
    // ambiguous and the claim must stay, exactly as in the giveup path.
    //
    // The defect is not new and is not command-specific — it is one of the
    // "three existing early returns [that] sit after the claim" named on
    // the connector gate above. Enabling this block for `/command` is what
    // made fixing it a precondition rather than a cleanup.
    if (promptDedupeKey && !state.promptDeliveryMayHaveReachedUpstream) {
      releasePromptDelivery(promptDedupeKey);
    }
    return refusal;
  }
  return null;
}

/**
 * PLACE THE WIRE ID against the target session's actual tip — for ANY
 * target, child sessions included. See `prompt-wire-id-repair.ts` for the
 * incident this closes. One bounded newest-N read; fail-open (a failed
 * read keeps the client's id); runs after every refusal point and before
 * the ledger begins, so the identity recorded is the one delivered. Once
 * per request: a retry attempt keeps the placement the first computed.
 * The inbox drain already placed its id and says so with a header — one
 * fewer round-trip. Any client can send that header, so it skips only
 * the READ: an id far ahead of the clock (the pre-fix CLI's high-bits
 * mint) is re-minted on the id alone either way.
 */
export async function placePromptWireId(
  req: ForwardRequest,
  state: ForwardState,
  previewUrl: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  const { promptDelivery, sandboxAuthored, remainingPath, incomingHeaders, ptl, sandboxId, record, turnIdentity } = req;
  const clientWireId = promptBodyMessageId(state.requestBody);
  const placedByInbox = incomingHeaders.get(WIRE_ID_PLACED_HEADER) === '1';
  if (
    promptDelivery &&
    !sandboxAuthored &&
    state.effectiveMessageId === null &&
    isPromptWireIdRepairPath(remainingPath) &&
    // No client id, nothing to place — OpenCode mints, and the read is
    // skipped entirely so a plain body pays nothing.
    clientWireId !== null &&
    (!placedByInbox || isWireIdAheadOf(clientWireId, Date.now()))
  ) {
    const readUrl =
      previewUrl.replace(/\/$/, '') +
      promptTranscriptReadPath(remainingPath, PROMPT_TRANSCRIPT_READ_LIMIT);
    const newestKnownTime = placedByInbox
      ? null
      : await readNewestWireIdTime({ url: readUrl, headers: authHeaders });
    ptl.mark('wire-id-read');
    const placed = repairPromptWireId({
      body: state.requestBody,
      newestKnownTime,
      nowMs: Date.now(),
    });
    if (placed.outcome === 'reminted') {
      console.warn('[prompt-wire-id] re-minted a stale or malformed client wire id', {
        sandboxId,
        sessionId: record.sessionId,
        path: remainingPath,
        effectiveMessageId: placed.effectiveMessageId,
      });
      state.requestBody = placed.body;
    }
    state.effectiveMessageId = placed.effectiveMessageId ?? '';
    if (turnIdentity && placed.effectiveMessageId) {
      turnIdentity.messageId = placed.effectiveMessageId;
    }
  }
}
