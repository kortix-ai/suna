import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { accountTokens } from '@kortix/db';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { config } from '../../config';
import { resolveLlmGatewayBaseUrl } from '../../llm-gateway/sandbox-base-url';
import type { ProviderName } from '../../platform/providers';
import { postEnvToDaemon } from './sandbox-env-transport';
import { waitForDaemonRuntimeReady } from './sandbox-daemon-ready';
import { resolveSessionNetworkBoundary } from './network-secret-boundary';
import { loadSessionSecretContext } from './session-secret-context';
import { decideEnvSyncAction, type EnvSyncMemoryState } from './env-sync-skip-decision';
import {
  type EnvSyncDurableRecord,
  loadEnvSyncDurableState,
  persistEnvSyncDurableState,
} from './env-sync-durable-state';
import { isBoxUnreachableError } from './sandbox-env-transport';
import {
  PROMPT_BOUNDARY_ARM_WAIT_MS,
  armedNetworkBoundaries,
  resolveSandboxEnvSnapshot,
  syncProviderNetworkBoundary,
  type SandboxEnvSnapshot,
} from './sandbox-env-snapshot';

export const FANOUT_CONCURRENCY = 6;

/**
 * Per-sandbox record of the last `refreshModels`-relevant payload THIS
 * PROCESS delivered to the daemon on the PER-PROMPT hot path
 * (`syncSandboxEnvForPrompt`).
 *
 * T3 (2026-09-14, #7016): every `/prompt_async|/message|/command` used to
 * post `refreshModels: true` unconditionally. The daemon's `/kortix/env`
 * already gates the actual reload on a value DELTA (`routes/env.ts`'s
 * `result.changed || opencodeEnvChanged`), so a byte-identical resend never
 * disposes/respawns OpenCode by itself — but it still paid for the round trip
 * on every turn.
 *
 * INCIDENT (2026-09-27): this memo is in-PROCESS, and the API runs at more
 * than one replica (`desired_count = 2` on dev; see
 * `infra/terraform/environments/dev-us-east-2/main.tf`). A load balancer round-robins
 * requests, so a session's consecutive turns routinely land on DIFFERENT
 * replicas — each one's memo is cold for a sandbox it has never personally
 * pushed to, so it re-posted `/kortix/env` and re-triggered a full OpenCode
 * respawn almost every turn instead of only the first. Measured: `send →
 * model starts` at 4.9s / 2.5s / 7.0s across three back-to-back trivial
 * prompts in ONE session, with the daemon logging a full
 * `[env] project env applied` 3.3–5.3s after every send.
 *
 * THIS MEMO IS NOW A FAST PATH ONLY, not the correctness boundary. The
 * correctness boundary is `env-sync-durable-state.ts`, persisted on
 * `session_sandboxes.config` — readable by every replica. See
 * `env-sync-skip-decision.ts` for the full three-way decision this memo feeds
 * into (push / skip / skip-and-background-refresh).
 *
 * INCIDENT (2026-10-16): the memo is trusted only while the durable record
 * still names its signature (`memoConfirmedBy`). A kortixd restart inside a
 * live box (an agent swap exits 75) seeds the new process from the BOOT env,
 * and another replica's push moves the box too. Neither touches this memo, so
 * a prompt inside the trusted window ran on an env the box no longer held: in
 * a private session, the creator's personal secret for another person's turn
 * (KRTX-2517). Both move the durable record (the daemon's boot claim fences
 * it), so a memo it no longer confirms is dropped.
 *
 * replica-local: by design — the durable half above is the cross-replica
 * correctness boundary, so each replica's copy of this memo may miss what
 * another replica confirmed.
 */
/** `person` = the session token's `on_behalf_of` when the env was confirmed:
 *  whose personal secrets the box holds. */
const lastPromptModelSignature = new Map<string, EnvSyncMemoryState & { agent: string; person: string | null }>();
/**
 * How stale a CONFIRMED-current record (memory or durable) may get before a
 * skip also fires a detached background re-push. This is not a correctness
 * TTL — the daemon's own store does not drift on its own, and a daemon process
 * restart is fenced at its boot claim (`recordDaemonBootForEnvSync`) — it is a
 * bounded self-heal for drift nothing reports (a provider-side reset). Same
 * reasoning, and the same order of magnitude, as this file's
 * `BOUNDARY_ARM_TTL_MS`. Exported so the benchmark script and tests don't
 * hardcode the number.
 */
export const ENV_SYNC_BACKGROUND_REFRESH_STALE_MS = 10 * 60_000;
/** Entries are ~200 bytes; the process is long-lived and external ids are
 *  never reused, so this must be bounded the same way `armedNetworkBoundaries`
 *  is. No TTL: unlike the boundary arm this is not self-healing drift, it is a
 *  pure memo of "what did we last tell this box", so eviction on capacity
 *  (oldest-write-first, same as the boundary cache) is enough. Exported so
 *  tests don't hardcode the number. */
export const PROMPT_MODEL_SIGNATURE_CACHE_MAX = 2_000;

/** Test seam: drop every remembered per-prompt signature. */
export function __resetPromptModelSignatureCacheForTests(): void {
  lastPromptModelSignature.clear();
}

/**
 * In-flight DETACHED background refreshes, keyed by sandbox external id.
 * Guards against two prompts on the same stale sandbox both firing a
 * redundant re-push — the second joins the first instead of starting a
 * second daemon round trip. Never awaited by a caller; see
 * `scheduleBackgroundEnvRefresh`.
 */
const inFlightBackgroundEnvRefresh = new Map<string, Promise<void>>();

/**
 * `externalId` → the earliest ms the NEXT background refresh for that sandbox
 * may fire, set when a refresh found the box UNREACHABLE (`isBoxUnreachableError`).
 *
 * KRTX-2590 (prod, 2026-10-16/17): a failed refresh updates neither the memo
 * nor the durable record — by design, so the next prompt re-decides from the
 * last KNOWN-good state — and for a box that is GONE that next decision is
 * `skip + scheduleBackgroundRefresh` again, on every prompt. One
 * cron-prompted dead session produced a steady ~16 failed pushes/hour
 * (351 in 26 h) that could not succeed until the box came back — which its
 * own boot-time env sync handles without this machinery. The backoff stops
 * the re-scheduling for the same window the staleness self-heal already uses
 * (`ENV_SYNC_BACKGROUND_REFRESH_STALE_MS` — one number, no new knob); a
 * successful push anywhere clears it, so a box that came back is re-probed on
 * the next stale-skip opportunity.
 *
 * replica-local: by design, like the memo — each replica learns on its own,
 * and a fresh replica's first probe costs one POST per window, not one per
 * prompt. Bounded like the memo (entries ~40 bytes, cleared on success and
 * logically expired by timestamp; eviction on capacity, oldest-first).
 */
const backgroundRefreshBackoffUntil = new Map<string, number>();

/** Test seam: let a suite wait for a scheduled background refresh instead of
 *  racing it, and start each case from a clean slate. */
export function __pendingBackgroundEnvRefreshesForTests(): Promise<void>[] {
  return [...inFlightBackgroundEnvRefresh.values()];
}
/** Test seam: read (and, to simulate time passing, rewrite) the unreachable
 *  backoff window. Production code never touches the map except through the
 *  one writer below. */
export function __backgroundRefreshBackoffForTests(): Map<string, number> {
  return backgroundRefreshBackoffUntil;
}
export function __resetBackgroundEnvRefreshForTests(): void {
  inFlightBackgroundEnvRefresh.clear();
  backgroundRefreshBackoffUntil.clear();
}
/** The detached checks of trusted prompts (`syncSandboxEnvForPrompt`). */
// replica-local: in-flight work of this process only.
const inFlightEnvChecks = new Set<Promise<void>>();
/** Test seam: let a suite wait for the background checks instead of racing them. */
export function __pendingEnvChecksForTests(): Promise<void>[] {
  return [...inFlightEnvChecks];
}

/**
 * Digest of EVERY value `syncSandboxEnvForPrompt` sends that can move the
 * daemon's `result.changed || opencodeEnvChanged` gate (`routes/env.ts:196`):
 *
 *   - `snapshot.revision` — a sha256 of the full granted project-secrets env
 *     (`projectSecretsRevision`), so any secret add/remove/rotation changes it.
 *     This is NOT limited to "model-relevant" secrets on purpose: a project
 *     secret delta is the daemon's ONLY signal to respawn opencode so its
 *     process env picks the new value up (see the comment on
 *     `pushSessionScopeToSandbox`), and the per-turn sync is sometimes the
 *     only path that ever re-delivers it (see `runPrePromptEnvSync`'s comment
 *     on `/command` self-heal). Narrowing this to a "model tokens" subset
 *     would silently stop propagating an unrelated secret rotation.
 *   - `snapshot.capabilitiesJson` — pushed as `KORTIX_SECRET_CAPABILITIES`,
 *     which is on the daemon's `RESPAWN_REQUIRED_ENV_NAMES` list.
 *   - the LLM gateway base URL.
 *   - `args.opencodeEnv` — an explicit runtime-env push a caller asked this
 *     same call to carry (see `continueSession`/continue-session.ts). Omitting it would silently drop that
 *     caller's request to apply its own change.
 *
 * Keys of `opencodeEnv` are sorted so caller-side object literal order never
 * produces a spurious digest change.
 */
function promptModelSignature(input: {
  revision: string;
  capabilitiesJson: string;
  llmGatewayBaseUrl: string;
  opencodeEnv?: Record<string, string | null>;
}): string {
  const opencodeEnvEntries = Object.entries(input.opencodeEnv ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify([
    input.revision,
    input.capabilitiesJson,
    input.llmGatewayBaseUrl,
    opencodeEnvEntries,
  ]);
}

/** The ONLY writer of the memo, and the only place the capacity bound is
 *  enforced — every write path (push, background refresh, the skip path's
 *  durable-record confirmation) records the signature and its confirmation
 *  time as ONE entry here, so the two halves can never drift apart and the
 *  map never outgrows `PROMPT_MODEL_SIGNATURE_CACHE_MAX`. */
function rememberPromptModelSignature(
  externalId: string,
  signature: string,
  appliedAtMs: number,
  agent: string,
  person: string | null,
): void {
  lastPromptModelSignature.delete(externalId);
  if (lastPromptModelSignature.size >= PROMPT_MODEL_SIGNATURE_CACHE_MAX) {
    const oldest = lastPromptModelSignature.keys().next();
    if (!oldest.done) lastPromptModelSignature.delete(oldest.value);
  }
  lastPromptModelSignature.set(externalId, { signature, pushedAtMs: appliedAtMs, agent, person });
}

/**
 * This box's memo, kept only while the durable record still names the same
 * signature. The memo is per replica and the box is one: a daemon restart (the
 * boot fence in env-sync-durable-state.ts) or another replica's push moves the
 * durable record and not this memo. A memo the record no longer confirms
 * describes an env the box may not hold, so it is dropped.
 */
function memoConfirmedBy(
  externalId: string,
  persisted: EnvSyncDurableRecord | null,
): (EnvSyncMemoryState & { agent: string; person: string | null }) | null {
  const memo = lastPromptModelSignature.get(externalId);
  if (!memo) return null;
  if (persisted?.signature === memo.signature) return memo;
  lastPromptModelSignature.delete(externalId);
  return null;
}

/**
 * The human the session's live token acts for (`on_behalf_of`), or null. A
 * private session's personal secrets are theirs; it changes when another person
 * prompts (projects/lib/on-behalf-of.ts). One indexed read.
 */
async function sessionTokenPerson(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ onBehalfOf: accountTokens.onBehalfOfUserId })
    .from(accountTokens)
    .where(
      and(
        eq(accountTokens.sessionId, sessionId),
        eq(accountTokens.status, 'active'),
        isNull(accountTokens.revokedAt),
        isNotNull(accountTokens.serviceAccountId),
      ),
    )
    .limit(1);
  return row?.onBehalfOf ?? null;
}

/**
 * Fire a DETACHED re-push of an already-confirmed-current env, for the "skip,
 * but it's stale" branch of `decideEnvSyncAction`. Never awaited by
 * `syncSandboxEnvForPrompt` and never lets a background failure surface to a
 * turn — see the header on `lastPromptModelSignature`/
 * `ENV_SYNC_BACKGROUND_REFRESH_STALE_MS`.
 *
 * Sends the SAME snapshot the caller already resolved for THIS prompt, not a
 * freshly re-resolved one: the signature already matched what memory/the
 * durable record last confirmed, so there is nothing new to discover — this
 * is a re-affirmation against possible daemon-side drift, not a check for a
 * change (a real change is caught by the signature mismatch on ITS own
 * triggering prompt, synchronously, before this function is ever reached).
 *
 * `refreshModels: true` is safe to send unconditionally here: the daemon's
 * `/kortix/env` no-ops a byte-identical push (`routes/env.ts`'s
 * `result.changed || opencodeEnvChanged` gate) — this call cannot itself
 * cause a respawn, so it can never interrupt whatever turn is running on the
 * box concurrently with it.
 */
function scheduleBackgroundEnvRefresh(args: {
  externalId: string;
  sessionId: string;
  previewUrl: string;
  providerHeaders: Record<string, string>;
  serviceKey: string;
  snapshot: SandboxEnvSnapshot;
  opencodeEnv?: Record<string, string | null>;
  llmGatewayBaseUrl: string;
  signature: string;
  agent: string;
  person: string | null;
}): boolean {
  if (inFlightBackgroundEnvRefresh.has(args.externalId)) return false;
  const backoffUntil = backgroundRefreshBackoffUntil.get(args.externalId);
  if (backoffUntil !== undefined && Date.now() < backoffUntil) return false;
  if (backgroundRefreshBackoffUntil.size >= PROMPT_MODEL_SIGNATURE_CACHE_MAX) {
    const oldest = backgroundRefreshBackoffUntil.keys().next();
    if (!oldest.done) backgroundRefreshBackoffUntil.delete(oldest.value);
  }
  const run = (async () => {
    try {
      await postEnvToDaemon({
        previewUrl: args.previewUrl,
        providerHeaders: args.providerHeaders,
        serviceKey: args.serviceKey,
        snapshot: args.snapshot,
        refreshModels: true,
        opencodeEnv: args.opencodeEnv,
        llmGatewayBaseUrl: args.llmGatewayBaseUrl,
      });
      const appliedAtMs = Date.now();
      rememberPromptModelSignature(args.externalId, args.signature, appliedAtMs, args.agent, args.person);
      await persistEnvSyncDurableState(args.sessionId, args.signature, appliedAtMs);
      backgroundRefreshBackoffUntil.delete(args.externalId);
      console.log(
        `[env-sync] background refresh confirmed current sandbox=${args.externalId} session=${args.sessionId}`,
      );
    } catch (err) {
      // Not remembered — same rule as a failed synchronous push. The next
      // prompt (synchronous or another background pass) re-decides from the
      // last KNOWN-good state and retries. The ONE exception is a box that
      // cannot serve the push at all: re-deciding on the next prompt would
      // re-fire a doomed push at prompt rate (the KRTX-2590 leak above), so
      // that verdict backs the refresh off for the self-heal window instead.
      if (isBoxUnreachableError(err)) {
        backgroundRefreshBackoffUntil.set(
          args.externalId,
          Date.now() + ENV_SYNC_BACKGROUND_REFRESH_STALE_MS,
        );
      }
      console.warn(
        `[env-sync] background refresh failed sandbox=${args.externalId} session=${args.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inFlightBackgroundEnvRefresh.delete(args.externalId);
    }
  })();
  inFlightBackgroundEnvRefresh.set(args.externalId, run);
  return true;
}

interface PromptEnvSyncArgs {
  projectId: string;
  sessionId: string;
  externalId: string;
  serviceKey: string | null;
  previewUrl: string;
  providerHeaders: Record<string, string>;
  /** The provider this sandbox actually runs on (`SandboxRecord.provider` at
   *  the call site) — needed to resolve the LLM-gateway base URL onto the
   *  RIGHT origin for a same-machine provider. */
  providerName: ProviderName;
  /** The agent this prompt asked to run (the body's `agent` field). The secret
   *  grant is resolved from THIS, not from the session's create-time agent —
   *  see resolveOwnerRawEnv. Null/'default' means "the session's own agent". */
  requestedAgent?: string | null;
  /** Runtime env the daemon applies before the prompt reaches OpenCode. */
  opencodeEnv?: Record<string, string | null>;
}

/**
 * Bring the box's env onto what this prompt's agent may read, before the prompt
 * is forwarded.
 *
 * TRUSTED FAST PATH (2026-10-13). Resolving the env costs every prompt the
 * session, project, grant, owner and secret reads plus a manifest read: 430 ms
 * median on prod (p90 2.3 s, 2026-10-12), and 90% of those prompts then found
 * nothing to push. When THIS process confirmed the box's env for the same agent
 * inside `ENV_SYNC_BACKGROUND_REFRESH_STALE_MS`, the prompt is forwarded at
 * once and the same resolve runs detached. A change it finds drops the memo, so
 * the NEXT prompt pushes it synchronously. So a secret, grant or gateway change
 * the write path did not already push reaches the box one turn later. Secret
 * writes push to running boxes themselves (`propagateProjectSecretsToActiveSandboxes`),
 * the token's grant is still re-minted before every turn (`remintGrantForAgentSwitch`),
 * and a broker-held secret is checked against the grant on every use.
 *
 * Never trusted: a different agent (its grant is resolved and pushed before it
 * runs), a different person (the session token now acts for someone else: the
 * box may hold the previous person's personal secrets), a caller's explicit
 * `opencodeEnv`, a process that has not confirmed this box itself, and a memo
 * the durable record no longer confirms (the box's daemon restarted, or
 * another replica pushed a different env — `memoConfirmedBy`).
 */
export async function syncSandboxEnvForPrompt(args: PromptEnvSyncArgs): Promise<void> {
  if (!args.serviceKey) return;
  const known = lastPromptModelSignature.get(args.externalId);
  const candidate =
    known &&
    !args.opencodeEnv &&
    known.agent === (args.requestedAgent ?? '') &&
    Date.now() - known.pushedAtMs < ENV_SYNC_BACKGROUND_REFRESH_STALE_MS
      ? known
      : null;
  // Two indexed reads in parallel. The durable record is read only when the
  // memo could be trusted: the sync path below reads it after its resolve.
  const [person, persisted] = await Promise.all([
    sessionTokenPerson(args.sessionId),
    candidate ? loadEnvSyncDurableState(args.sessionId) : null,
  ]);
  if (candidate && candidate.person === person && memoConfirmedBy(args.externalId, persisted)) {
    const check = resolveAndSyncEnv(args, 'check', person)
      .catch((err) => {
        lastPromptModelSignature.delete(args.externalId);
        logger.warn('[env-sync] background check failed; the next prompt syncs synchronously', {
          sandbox: args.externalId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => inFlightEnvChecks.delete(check));
    inFlightEnvChecks.add(check);
    logger.info('[env-sync] push=trusted', { sandbox: args.externalId });
    return;
  }
  await resolveAndSyncEnv(args, 'sync', person);
}

/** `check`: resolve and compare only — a difference drops the memo, nothing is pushed. */
async function resolveAndSyncEnv(args: PromptEnvSyncArgs, mode: 'sync' | 'check', person: string | null): Promise<void> {
  if (!args.serviceKey) return;
  const agent = args.requestedAgent ?? '';
  const t0 = performance.now();
  const timing: Record<string, number> = {};
  const lap = (label: string) => {
    timing[label] = Math.round(performance.now() - t0 - Object.values(timing).reduce((a, b) => a + b, 0));
  };
  // The snapshot, the network boundary and the gateway flag read DIFFERENT
  // rows for the same session and project, and none of them consumes another's
  // result. They start together and are awaited in the original order, so a
  // failure still surfaces at the same place and with the same meaning — the
  // boundary's fail-closed grant error included.
  // Both read the session row, the project row, the running agent's grant and
  // the personal-override owner. One context answers both.
  const secretContext = loadSessionSecretContext(args.projectId, args.sessionId, args.requestedAgent);
  secretContext.catch(() => undefined);
  const boundaryRead = resolveSessionNetworkBoundary(
    args.projectId,
    args.sessionId,
    args.requestedAgent,
    secretContext,
  );
  boundaryRead.catch(() => undefined);
  const snapshot = await resolveSandboxEnvSnapshot(
    args.projectId,
    args.sessionId,
    args.requestedAgent,
    secretContext,
  );
  lap('snapshot');
  if (!snapshot) return;
  // Resolving the bindings stays FAIL-CLOSED: it re-reads the agent's grant, and
  // an unresolvable grant must refuse the prompt (the caller maps
  // SecretGrantResolutionError to its own 503).
  //
  // This line used to be justified with "resolveSandboxEnvSnapshot above already
  // resolved the same grant and threw first". That was false, and it is how the
  // removed grant lock kept 409-ing real switches while its config flag was off:
  // the call above passed the flag explicitly (false, so it did NOT throw) while
  // this leg omitted it and landed on the resolver's `?? true` default, so THIS
  // was the line that threw. The parameter is gone, so the two legs can no
  // longer disagree about policy — they share one resolver with one behavior.
  const networkBoundary = await boundaryRead;
  lap('boundary');
  // Sampled BEFORE the attempt, because a failed arm forgets its record. `true`
  // means this process already armed a DIFFERENT set on this sandbox (an
  // unchanged set never reaches the provider at all), so a failure below leaves
  // the edge holding the PREVIOUS bindings. That is the one case the fail-soft
  // below does not fully cover: a narrowing that does not land keeps a
  // credential injectable at the edge — still never readable in the guest —
  // until the next successful arm. It is logged so it is greppable.
  // A REVOCATION must not fail soft. When the desired set drops a binding this
  // process already recorded, that shrink is the revocation. It is now cheap —
  // the value is fetched per request by the broker route and the guest's handle
  // stops being spendable the moment the grant changes — but the accounting
  // stays raised rather than swallowed: a shrink that does not land is the one
  // direction that can widen what an agent may spend. A widening or a rotation
  // that fails still forwards the turn.
  const priorArm = armedNetworkBoundaries.get(args.externalId);
  const hadPriorArm = priorArm !== undefined;
  const nextSecretIds = new Set(networkBoundary.map((binding) => binding.secretId));
  const revokesArmedBinding = (priorArm?.secretIds ?? []).some((id) => !nextSecretIds.has(id));
  try {
    // A WIDENING, by contrast, fails SOFT — a failed or late record cannot leak.
    // An egress-enforced secret's value never enters the sandbox: the guest gets
    // a handle and the broker route substitutes the value server-side. So
    // skipping this cannot disclose anything; the only consequence is bookkeeping
    // the next call redoes. Failing the turn on it is what made one egress secret
    // 502 EVERY prompt in the project, with the agent unable to run at all.
    //
    // SCOPE: this fail-soft covers the binding record and nothing else. It does
    // not extend to the grant resolution above (failing open there would widen
    // what the agent may read), and it must not be copied into the provision
    // path in platform/services/session-sandbox.ts — a session whose boundary
    // policy is unusable should still fail to provision, loudly.
    const armState = await syncProviderNetworkBoundary(
      args.providerName,
      args.externalId,
      networkBoundary,
      { maxWaitMs: PROMPT_BOUNDARY_ARM_WAIT_MS },
    );
    if (armState === 'pending' && revokesArmedBinding) {
      throw new Error(
        `network-boundary revocation did not land within ${PROMPT_BOUNDARY_ARM_WAIT_MS}ms for ${args.externalId}`,
      );
    }
    if (armState === 'pending') {
      console.warn(
        `[env-sync] network boundary still arming after ${PROMPT_BOUNDARY_ARM_WAIT_MS}ms; ` +
          `forwarding the prompt without waiting session=${args.sessionId} sandbox=${args.externalId} ` +
          `bindings=${networkBoundary.length} replaces-previous-set=${hadPriorArm}`,
      );
    }
  } catch (err) {
    // The one case that must still refuse the turn: an arm that would have
    // REMOVED a binding the edge is holding. See the comment on
    // `revokesArmedBinding`.
    if (revokesArmedBinding) throw err;
    console.warn(
      `[env-sync] network-boundary arm failed; continuing the turn without it ` +
        `session=${args.sessionId} sandbox=${args.externalId} bindings=${networkBoundary.length} ` +
        `replaces-previous-set=${hadPriorArm}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  lap('arm');
  const llmGatewayBaseUrl = resolveLlmGatewayBaseUrl(config.KORTIX_URL);
  // Only ask the daemon to reload when something that could move ITS
  // `result.changed || opencodeEnvChanged` gate has actually changed since the
  // last CONFIRMED-applied signature for this sandbox. "Confirmed" is checked
  // first against this process's own memo, then — only on a memo miss —
  // against the DURABLE per-session record any replica may have written
  // (`env-sync-durable-state.ts`). See `env-sync-skip-decision.ts` for the
  // full three-way decision (push / skip / skip-and-background-refresh) and
  // the 2026-09-27 incident that made the durable leg necessary: a 2-replica
  // API meant the in-process-only memo missed on roughly half of every
  // session's turns. `promptModelSignature` is NOT limited to "model" fields —
  // project-secret deltas ride the same gate and must never be silently
  // skipped.
  const signature = promptModelSignature({
    revision: snapshot.revision,
    capabilitiesJson: snapshot.capabilitiesJson,
    llmGatewayBaseUrl,
    opencodeEnv: args.opencodeEnv,
  });
  if (mode === 'check') {
    if (lastPromptModelSignature.get(args.externalId)?.signature !== signature) {
      lastPromptModelSignature.delete(args.externalId);
      logger.info('[env-sync] background check found a change; the next prompt pushes it', { sandbox: args.externalId });
    }
    return;
  }
  // Read AFTER the resolve, and even when the memo matches: a daemon boot or
  // another replica's push recorded while the env resolved must still turn
  // this prompt into a push (`memoConfirmedBy`).
  const persisted = await loadEnvSyncDurableState(args.sessionId);
  lap('durable-read');
  const memory = memoConfirmedBy(args.externalId, persisted);
  const decision = decideEnvSyncAction({
    signature,
    memory,
    persisted,
    nowMs: Date.now(),
    backgroundRefreshStaleMs: ENV_SYNC_BACKGROUND_REFRESH_STALE_MS,
  });
  if (decision.action === 'skip') {
    // Confirmed current — by this process or by another replica. Nothing to
    // say, and the daemon would no-op it. Skip the round-trip entirely: the
    // turn pays only the proxy hop, never the daemon RTT or a respawn wait.
    // Same single writer as a push, so the capacity bound holds here too and
    // the confirmed-at time stays exactly what the durable record said.
    rememberPromptModelSignature(args.externalId, signature, decision.appliedAtMs, agent, person);
    let backgroundRefreshScheduled = false;
    if (decision.scheduleBackgroundRefresh) {
      // Self-heal for drift THIS process did not cause. Detached: never
      // awaited here, and a failure inside it never touches this turn. The
      // return says whether a refresh actually fired — a backoff (the box was
      // unreachable at its last attempt) or an in-flight refresh keeps the
      // log honest instead of promising a push that will not happen.
      backgroundRefreshScheduled = scheduleBackgroundEnvRefresh({
        externalId: args.externalId,
        sessionId: args.sessionId,
        previewUrl: args.previewUrl,
        providerHeaders: args.providerHeaders,
        serviceKey: args.serviceKey,
        snapshot,
        opencodeEnv: args.opencodeEnv,
        llmGatewayBaseUrl,
        signature,
        agent,
        person,
      });
    }
    console.log(
      `[env-sync] timing sandbox=${args.externalId} push=skipped ` +
        `background_refresh=${backgroundRefreshScheduled} ${JSON.stringify(timing)}`,
    );
    return;
  }
  // `decision.action === 'push'`: either the first prompt of a session (no
  // memo, no durable record) or a genuine change (the signature matches
  // neither) — always a real reload request.
  const { opencodeState } = await postEnvToDaemon({
    previewUrl: args.previewUrl,
    providerHeaders: args.providerHeaders,
    serviceKey: args.serviceKey,
    snapshot,
    refreshModels: true,
    opencodeEnv: args.opencodeEnv,
    llmGatewayBaseUrl,
  });
  // Remember only AFTER a successful push — in-process AND durably. A throw
  // above (network/HTTP failure) must leave BOTH alone so the next prompt, on
  // this replica or any other, retries with a real push again instead of
  // assuming the failed attempt landed.
  const appliedAtMs = Date.now();
  rememberPromptModelSignature(args.externalId, signature, appliedAtMs, agent, person);
  await persistEnvSyncDurableState(args.sessionId, signature, appliedAtMs);
  // The box just served a real push — any unreachable backoff it was under is
  // stale by observation.
  backgroundRefreshBackoffUntil.delete(args.externalId);
  lap('push');
  // A model-affecting change just restarted opencode (state !== 'ok'). The prompt
  // is forwarded the instant this returns, so block until opencode is serving —
  // otherwise the forward hits the restart window and 503s "opencode not ready",
  // dropping the session's first prompt (the user then has to resend).
  if (opencodeState && opencodeState !== 'ok') {
    const waitStartedAt = Date.now();
    const ready = await waitForDaemonRuntimeReady({
      previewUrl: args.previewUrl,
      providerHeaders: args.providerHeaders,
    });
    console.log(
      `[env-sync] opencode restarted by prompt env-sync (state=${opencodeState}); ` +
        `waited ${Date.now() - waitStartedAt}ms for readiness before forwarding ` +
        `(ready=${ready}) session=${args.sessionId}`,
    );
  }
  console.log(`[env-sync] timing sandbox=${args.externalId} push=sent refreshModels=true ${JSON.stringify(timing)}`);
}

export async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
