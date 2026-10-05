import { and, eq, sql } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { config } from '../../config';
import { projectLlmGatewayEnabledById } from '../../llm-gateway/enablement';
import { resolveLlmGatewayBaseUrl } from '../../llm-gateway/sandbox-base-url';
import type { ProviderName } from '../../platform/providers';
import { waitForDaemonRuntimeReady } from './sandbox-daemon-ready';
import { SECRET_CAPABILITIES_ENV_NAME } from '../secret-capabilities';
import { resolveSessionNetworkBoundary } from './network-secret-boundary';
import { loadSessionSecretContext } from './session-secret-context';
import { decideEnvSyncAction, type EnvSyncMemoryState } from './env-sync-skip-decision';
import { loadEnvSyncDurableState, persistEnvSyncDurableState } from './env-sync-durable-state';
import {
  PROMPT_BOUNDARY_ARM_WAIT_MS,
  armedNetworkBoundaries,
  resolveSandboxEnvSnapshot,
  syncProviderNetworkBoundary,
  type SandboxEnvSnapshot,
} from './sandbox-env-snapshot';

/** Resolve the LLM gateway URL used by every supported remote provider. */
export function llmGatewayBaseUrlForProvider(_providerName: ProviderName): string {
  return resolveLlmGatewayBaseUrl(config.KORTIX_URL);
}

export const SANDBOX_SERVICE_PORT = 8000;
export const FANOUT_CONCURRENCY = 6;
const ENV_PUSH_TIMEOUT_MS = 15_000;

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
 * `infra/terraform/environments/dev/main.tf`). A load balancer round-robins
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
 * into (push / skip / skip-and-background-refresh) and why memory always
 * wins over the durable record when both are present.
 *
 * replica-local: by design — the durable half above is the cross-replica
 * correctness boundary, so each replica's copy of this memo may miss what
 * another replica confirmed.
 */
const lastPromptModelSignature = new Map<string, EnvSyncMemoryState>();
/**
 * How stale a CONFIRMED-current record (memory or durable) may get before a
 * skip also fires a detached background re-push. This is not a correctness
 * TTL — the daemon's own store does not drift on its own — it is a bounded
 * self-heal for drift THIS process did not cause (the daemon's process
 * restarting and losing its applied env, a provider-side reset). Same
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

/** Test seam: let a suite wait for a scheduled background refresh instead of
 *  racing it, and start each case from a clean slate. */
export function __pendingBackgroundEnvRefreshesForTests(): Promise<void>[] {
  return [...inFlightBackgroundEnvRefresh.values()];
}
export function __resetBackgroundEnvRefreshForTests(): void {
  inFlightBackgroundEnvRefresh.clear();
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
 *   - the LLM-gateway mode and base URL.
 *   - `args.opencodeEnv` — an explicit runtime-env push a caller asked this
 *     same call to carry (e.g. a channel follow-up's `KORTIX_CONNECTORS_MCP_ENABLED`,
 *     see `continueSession`/continue-session.ts). Omitting it would silently drop that
 *     caller's request to apply its own change.
 *
 * Keys of `opencodeEnv` are sorted so caller-side object literal order never
 * produces a spurious digest change.
 */
function promptModelSignature(input: {
  revision: string;
  capabilitiesJson: string;
  llmGatewayEnabled: boolean;
  llmGatewayBaseUrl?: string;
  opencodeEnv?: Record<string, string | null>;
}): string {
  const opencodeEnvEntries = Object.entries(input.opencodeEnv ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify([
    input.revision,
    input.capabilitiesJson,
    input.llmGatewayEnabled,
    input.llmGatewayBaseUrl ?? '',
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
): void {
  lastPromptModelSignature.delete(externalId);
  if (lastPromptModelSignature.size >= PROMPT_MODEL_SIGNATURE_CACHE_MAX) {
    const oldest = lastPromptModelSignature.keys().next();
    if (!oldest.done) lastPromptModelSignature.delete(oldest.value);
  }
  lastPromptModelSignature.set(externalId, { signature, pushedAtMs: appliedAtMs });
}

function isSecureOrPrivateTarget(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname;
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(h)) return true;
  if (!h.includes('.')) return true; // single-label docker/service name on a private bridge
  if (/\.(local|internal|svc|cluster\.local)$/.test(h)) return true;
  // RFC1918 / link-local — anchored to full IPv4 literals so a public hostname
  // like "10.foo.evil.com" can't slip through a `^10.` prefix match.
  if (/^10(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 unique-local
  return false; // plain http to a public host — refuse to send secrets in cleartext
}

/** The daemon answered the env push with a non-2xx. */
export class EnvSyncHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`env sync failed: ${status}${body ? ` ${body.slice(0, 500)}` : ''}`);
    this.name = 'EnvSyncHttpError';
  }
}

export async function postEnvToDaemon(args: {
  previewUrl: string;
  providerHeaders: Record<string, string>;
  serviceKey: string;
  snapshot: SandboxEnvSnapshot;
  refreshModels?: boolean;
  /** Runtime env the daemon applies to the OPENCODE process (allow-listed there). */
  opencodeEnv?: Record<string, string | null>;
  llmGatewayEnabled?: boolean;
  llmGatewayBaseUrl?: string;
  requireAgentEnvProof?: boolean;
}): Promise<{
  opencodeState: string | null;
  revision: string;
  exported: number;
  managed: number | null;
  withheld: number | null;
  agentEnvWritten: boolean;
  /**
   * How the daemon applied the config, or null when it did not say (an older
   * daemon, or no reload was needed). 'kept-old' is the verified swap
   * declining: the new opencode never came up and the previous one still
   * serves — the push landed, the config did not.
   */
  opencodeReload: 'disposed' | 'restarted' | 'kept-old' | null;
  /**
   * Did applying the config interrupt a turn someone was waiting on?
   * `null` = the box did not say (older daemon, or no reload happened).
   */
  opencodeTurnEnded: boolean | null;
}> {
  if (!isSecureOrPrivateTarget(args.previewUrl)) {
    throw new Error('refusing to push secrets over insecure transport (non-TLS public host)');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${args.serviceKey}`,
    ...args.providerHeaders,
  };

  const runtimeEnv = {
    ...(args.opencodeEnv ?? {}),
    [SECRET_CAPABILITIES_ENV_NAME]: args.snapshot.capabilitiesJson,
  };
  const res = await fetch(`${args.previewUrl.replace(/\/$/, '')}/kortix/env`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      env: args.snapshot.env,
      names: args.snapshot.names,
      revision: args.snapshot.revision,
      refreshModels: args.refreshModels ?? false,
      runtimeEnv,
      // The same map under its pre-W3 name, for a daemon built before W3.
      opencodeEnv: runtimeEnv,
      ...(typeof args.llmGatewayEnabled === 'boolean'
        ? {
            llmGatewayEnabled: args.llmGatewayEnabled,
            ...(args.llmGatewayBaseUrl ? { llmGatewayBaseUrl: args.llmGatewayBaseUrl } : {}),
          }
        : {}),
    }),
    signal: AbortSignal.timeout(ENV_PUSH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new EnvSyncHttpError(res.status, body);
  }
  // The daemon echoes opencode's post-sync state. After a model-affecting change
  // it restarts opencode and reports `starting` here — the signal we use to wait
  // for readiness before the prompt is forwarded.
  const body = (await res.json().catch(() => null)) as {
    ok?: unknown;
    revision?: unknown;
    exported?: unknown;
    managed?: unknown;
    withheld?: unknown;
    agent_env_written?: unknown;
    runtime?: unknown;
    runtime_reload?: unknown;
    runtime_turn_ended?: unknown;
    /** Pre-W3 names of the three fields above; a daemon built before W3 sends only these. */
    opencode?: unknown;
    opencode_reload?: unknown;
    opencode_turn_ended?: unknown;
  } | null;
  const runtimeState = body?.runtime ?? body?.opencode;
  const runtimeReload = body?.runtime_reload ?? body?.opencode_reload;
  const runtimeTurnEnded = body?.runtime_turn_ended ?? body?.opencode_turn_ended;
  const expectedExported = Object.keys(args.snapshot.env).length;
  if (args.requireAgentEnvProof) {
    if (!body || body.ok !== true) throw new Error('env sync proof missing ok=true');
    if (body.revision !== args.snapshot.revision) {
      throw new Error(`env sync revision mismatch: expected ${args.snapshot.revision}, received ${String(body.revision)}`);
    }
    if (body.agent_env_written !== true) {
      throw new Error('env sync did not confirm agent-env.sh write');
    }
    if (body.exported !== expectedExported) {
      throw new Error(`env sync export mismatch: expected ${expectedExported}, received ${String(body.exported)}`);
    }
  }
  return {
    opencodeState: typeof runtimeState === 'string' ? runtimeState : null,
    // How the daemon applied the config. 'kept-old' means the verified swap
    // declined: the new opencode never came up, so the running one still
    // serves and the change did NOT take. An older daemon omits the field
    // entirely — null, meaning "could not tell", never "it worked".
    opencodeReload:
      typeof runtimeReload === 'string' ? (runtimeReload as 'disposed' | 'restarted' | 'kept-old') : null,
    opencodeTurnEnded: typeof runtimeTurnEnded === 'boolean' ? runtimeTurnEnded : null,
    revision: typeof body?.revision === 'string' ? body.revision : args.snapshot.revision,
    exported: typeof body?.exported === 'number' ? body.exported : expectedExported,
    managed: typeof body?.managed === 'number' ? body.managed : null,
    withheld: typeof body?.withheld === 'number' ? body.withheld : null,
    agentEnvWritten: body?.agent_env_written === true,
  };
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
  llmGatewayEnabled: boolean;
  llmGatewayBaseUrl?: string;
  signature: string;
}): void {
  if (inFlightBackgroundEnvRefresh.has(args.externalId)) return;
  const run = (async () => {
    try {
      await postEnvToDaemon({
        previewUrl: args.previewUrl,
        providerHeaders: args.providerHeaders,
        serviceKey: args.serviceKey,
        snapshot: args.snapshot,
        refreshModels: true,
        opencodeEnv: args.opencodeEnv,
        llmGatewayEnabled: args.llmGatewayEnabled,
        llmGatewayBaseUrl: args.llmGatewayBaseUrl,
      });
      const appliedAtMs = Date.now();
      rememberPromptModelSignature(args.externalId, args.signature, appliedAtMs);
      await persistEnvSyncDurableState(args.sessionId, args.signature, appliedAtMs);
      console.log(
        `[env-sync] background refresh confirmed current sandbox=${args.externalId} session=${args.sessionId}`,
      );
    } catch (err) {
      // Not remembered — same rule as a failed synchronous push. The next
      // prompt (synchronous or another background pass) re-decides from the
      // last KNOWN-good state and retries.
      console.warn(
        `[env-sync] background refresh failed sandbox=${args.externalId} session=${args.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inFlightBackgroundEnvRefresh.delete(args.externalId);
    }
  })();
  inFlightBackgroundEnvRefresh.set(args.externalId, run);
}

export async function syncSandboxEnvForPrompt(args: {
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
}): Promise<void> {
  if (!args.serviceKey) return;
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
  const gatewayRead = projectLlmGatewayEnabledById(args.projectId);
  boundaryRead.catch(() => undefined);
  gatewayRead.catch(() => undefined);
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
  const llmGatewayEnabled = await gatewayRead;
  lap('gateway-flag');
  const llmGatewayBaseUrl = llmGatewayEnabled
    ? llmGatewayBaseUrlForProvider(args.providerName)
    : undefined;
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
    llmGatewayEnabled,
    llmGatewayBaseUrl,
    opencodeEnv: args.opencodeEnv,
  });
  const memory = lastPromptModelSignature.get(args.externalId) ?? null;
  // Pay for the durable read only when THIS process's own memo cannot already
  // answer — memory is always at least as fresh (see the note on
  // `decideEnvSyncAction`), so a matching memo makes the read pure overhead.
  const persisted =
    memory?.signature === signature ? null : await loadEnvSyncDurableState(args.sessionId);
  lap('durable-read');
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
    rememberPromptModelSignature(args.externalId, signature, decision.appliedAtMs);
    if (decision.scheduleBackgroundRefresh) {
      // Self-heal for drift THIS process did not cause. Detached: never
      // awaited here, and a failure inside it never touches this turn.
      scheduleBackgroundEnvRefresh({
        externalId: args.externalId,
        sessionId: args.sessionId,
        previewUrl: args.previewUrl,
        providerHeaders: args.providerHeaders,
        serviceKey: args.serviceKey,
        snapshot,
        opencodeEnv: args.opencodeEnv,
        llmGatewayEnabled,
        llmGatewayBaseUrl,
        signature,
      });
    }
    // Bookkeeping, and on this path the stored flag already matches in the
    // steady state: the turn does not wait for a write that changes nothing.
    void markSandboxLlmGatewayMode(args.sessionId, llmGatewayEnabled).catch(() => undefined);
    console.log(
      `[env-sync] timing sandbox=${args.externalId} push=skipped ` +
        `background_refresh=${decision.scheduleBackgroundRefresh} ${JSON.stringify(timing)}`,
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
    llmGatewayEnabled,
    llmGatewayBaseUrl,
  });
  // Remember only AFTER a successful push — in-process AND durably. A throw
  // above (network/HTTP failure) must leave BOTH alone so the next prompt, on
  // this replica or any other, retries with a real push again instead of
  // assuming the failed attempt landed.
  const appliedAtMs = Date.now();
  rememberPromptModelSignature(args.externalId, signature, appliedAtMs);
  await persistEnvSyncDurableState(args.sessionId, signature, appliedAtMs);
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
  await markSandboxLlmGatewayMode(args.sessionId, llmGatewayEnabled);
  lap('mark');
  console.log(`[env-sync] timing sandbox=${args.externalId} push=sent refreshModels=true ${JSON.stringify(timing)}`);
}

export async function propagateLlmGatewayModeToActiveSandboxes(
  projectId: string,
  enabled: boolean,
): Promise<void> {
  try {
    const rows = await db
      .select({
        externalId: sessionSandboxes.externalId,
        sessionId: sessionSandboxes.sessionId,
        provider: sessionSandboxes.provider,
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.projectId, projectId), eq(sessionSandboxes.status, 'active')));

    const targets = rows.filter((r): r is typeof r & { externalId: string } => !!r.externalId);
    if (targets.length === 0) return;

    // Computed PER ROW (not once, hoisted) — a project's active sandboxes can
    // span more than one provider (mid-migration, failover), and each needs
    // the base URL resolved onto ITS OWN provider's origin.
    await runBounded(targets, FANOUT_CONCURRENCY, async (row) => {
      const rowConfig = (row.config || {}) as Record<string, unknown>;
      const serviceKey = typeof rowConfig.serviceKey === 'string' ? rowConfig.serviceKey : null;
      if (!serviceKey) return;
      try {
        const snapshot =
          (await resolveSandboxEnvSnapshot(projectId, row.sessionId)) ??
          emptySandboxEnvSnapshot(`llm-gateway-${enabled ? 'on' : 'off'}`);
        const { url, headers } = await resolveSandboxIngress(row.externalId, { port: SANDBOX_SERVICE_PORT, transport: 'http' });
        await postEnvToDaemon({
          previewUrl: url,
          providerHeaders: headers,
          serviceKey,
          snapshot,
          refreshModels: true,
          llmGatewayEnabled: enabled,
          llmGatewayBaseUrl: enabled ? llmGatewayBaseUrlForProvider(row.provider as ProviderName) : undefined,
        });
        await markSandboxLlmGatewayMode(row.sessionId, enabled);
      } catch (err) {
        console.warn(
          `[env-sync] LLM gateway mode push failed for sandbox ${row.externalId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
  } catch (err) {
    console.warn(
      `[env-sync] LLM gateway mode fan-out failed for project ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Record which model route this box is on. ONE conditional statement: the flag
 * is merged into `config` in the database, and the row is only touched when the
 * stored value actually differs. This ran as a read plus an unconditional
 * rewrite of the identical value on EVERY prompt — two round trips to change
 * nothing in the steady state. `updated_at` still moves per prompt through the
 * turn-ledger writes, so nothing that watches the row for activity loses a
 * signal.
 */
export async function markSandboxLlmGatewayMode(
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      config: sql`COALESCE(${sessionSandboxes.config}, '{}'::jsonb) || jsonb_build_object('llmGatewayEnabled', ${enabled}::boolean)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionSandboxes.sessionId, sessionId),
        sql`(${sessionSandboxes.config}->>'llmGatewayEnabled') IS DISTINCT FROM ${String(enabled)}`,
      ),
    );
}

function emptySandboxEnvSnapshot(reason: string): SandboxEnvSnapshot {
  return {
    env: {},
    names: [],
    revision: `${reason}-${Date.now()}`,
    scope: 'inherit',
    capabilitiesJson: '{"version":1,"capabilities":[]}',
  };
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
