/**
 * Self-heal on an UNKNOWN MODEL, at turn start — the third lane in
 * `turn-start-convergence.ts`'s chokepoint, and the one this closes:
 *
 *   config-releases:      CONFIG BLOCKS THE TURN.
 *   runtime-assets:        BINARIES MUST NOT BLOCK.
 *   this file:             DETECT CHEAPLY AND ALWAYS; REPAIR EAGERLY ONLY
 *                          WHEN THE REQUESTED MODEL IS ABSENT.
 *
 * A model catalog is neither of the other two shapes. A catalog that merely
 * CHANGED must not make every prompt wait for an OpenCode restart — that is
 * `runtime-assets/manifest.ts`'s new `managed-catalog` component, which rides
 * the existing non-blocking asset lane (`scheduleAssetConvergence`) and a
 * plain `POST /kortix/refresh?restart=0` (see `convergeManagedModelCatalog`,
 * `allowRestart: false`, in the daemon). But a catalog that is missing THE
 * MODEL THIS VERY TURN ASKS FOR must be repaired BEFORE the turn runs,
 * because the alternative is exactly what a real user saw 2026-09-26:
 * `Model not found: kortix/deepseek-v4.1-flash` while the control plane
 * served that model the whole time. That is what this gate does, and it is
 * the ONLY one of the three lanes that is sometimes awaited on the send path.
 *
 * WHY IT COSTS A CURRENT BOX NOTHING. Gated on `isRuntimeManagedModelId`
 * first — a BYOK/custom-provider request never reaches the memo or the
 * network. For a managed-model request, the common case is a memo HIT
 * (`lastKnownManagedCatalog`, populated by the SAME health read
 * `turn-start-convergence.ts`'s config gate already makes when its own memo
 * is cold) confirming the model is present: one in-process map read, zero
 * network calls.
 *
 * WHAT IT NEVER DOES. `POST /kortix/catalog/converge` — the one call this
 * gate can make — is idle-gated and verified-swap based on the daemon side
 * (`convergeManagedModelCatalog` in the sandbox agent server), exactly like
 * `config-release.ts`: it never ends a running turn, and it takes ONE
 * attempt with a bounded timeout, never a retry ladder.
 */

import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { loadActiveSandbox } from './sandbox-runtime-refresh';
import {
  lastKnownManagedCatalog,
  noteRunningCatalog,
} from '../../runtime-assets/running-catalog';
import { logger } from '../../lib/logger';

/**
 * ONE attempt, bounded — no retry ladder. Called from the turn-start gate,
 * which must return in time to let the prompt through. The daemon's own
 * fetch of the live managed listing has its own ≤5s budget
 * (`MANAGED_MODELS_TOTAL_BUDGET_MS` in lifecycle.ts); this timeout is the
 * outer bound so an unreachable box cannot hold a turn hostage.
 */
const REQUEST_TIMEOUT_MS = 8_000;

export interface ModelCatalogConvergeDeps {
  loadActiveSandbox: (
    sessionId: string,
  ) => Promise<{ externalId: string; serviceKey: string } | null>;
  resolveIngress: (
    externalId: string,
  ) => Promise<{ url: string; headers: Record<string, string> }>;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

const SANDBOX_SERVICE_PORT = 8000;

const defaultConvergeDeps: ModelCatalogConvergeDeps = {
  loadActiveSandbox,
  resolveIngress: (externalId) =>
    resolveSandboxIngress(externalId, { port: SANDBOX_SERVICE_PORT, transport: 'http' }),
  fetch: globalThis.fetch,
};

/** `POST /kortix/catalog/converge`. Null on any failure to reach or parse —
 *  the caller treats that as "could not repair", never as "confirmed absent"
 *  or "confirmed present". */
export async function convergeSandboxModelCatalog(
  sessionId: string,
  deps: ModelCatalogConvergeDeps = defaultConvergeDeps,
): Promise<{ outcome: string; missing?: string[] } | null> {
  try {
    const sandbox = await deps.loadActiveSandbox(sessionId);
    if (!sandbox) return null;
    const ingress = await deps.resolveIngress(sandbox.externalId);
    const res = await deps.fetch(`${ingress.url.replace(/\/+$/, '')}/kortix/catalog/converge`, {
      method: 'POST',
      headers: { ...ingress.headers, Authorization: `Bearer ${sandbox.serviceKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { outcome?: unknown; missing?: unknown }
      | null;
    if (!body || typeof body.outcome !== 'string') return null;
    return {
      outcome: body.outcome,
      missing: Array.isArray(body.missing)
        ? body.missing.filter((v): v is string => typeof v === 'string')
        : undefined,
    };
  } catch (error) {
    logger.warn('[projects] on-demand catalog converge could not reach the box', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export type ModelCatalogTurnStartDecision =
  /** Not a managed-model request (BYOK/other provider, or no model on the
   *  body) — this lane has nothing to do with it. */
  | 'skipped'
  /** The box's confirmed map already has the requested model. Zero network
   *  calls when the memo was already warm. */
  | 'current'
  /** The model was missing, unconfirmed, or unknown — one converge call ran. */
  | 'converged'
  /** Could not confirm and could not repair (the box is unreachable). The
   *  turn proceeds regardless; this lane never refuses a prompt. */
  | 'unknown';

/**
 * `daemonOutcome` is what makes a `'converged'` decision ACTIONABLE for the
 * caller, not just observed. 2026-09-26: a stale box's turn failed with an
 * opaque OpenCode `500 UnknownError` — no cause named, not retryable in any
 * informed way. `daemonOutcome` is the fact that tells `forwardToSandbox`
 * whether the repair actually landed IN TIME for the request it is about to
 * forward, so it can refuse with a diagnosable error instead of proxying
 * into a guaranteed failure:
 *   - `'restarted'` — a fresh OpenCode is up with the model. Forward normally.
 *   - `'unchanged'` / `'file-updated'` — nothing to swap, or the file is
 *     staged for the box's NEXT natural restart. Forward normally; if the
 *     model was genuinely absent this is `declined`/`no-gateway`, not these.
 *   - `'declined'` — a turn was live, or the verified swap did not boot. The
 *     RUNNING process still lacks the model. Refuse this one turn.
 *   - `'no-gateway'` — the box could not even fetch the live lineup (no
 *     credentials, or the gateway did not answer). Refuse this one turn.
 */
export interface ModelCatalogTurnStartResult {
  decision: ModelCatalogTurnStartDecision;
  daemonOutcome?: string;
}

/** `true` only when the repair definitively did NOT land for the CURRENT
 *  running process — the two daemon outcomes that mean the model is still
 *  absent from what will actually answer this turn. */
export function modelCatalogRepairIncomplete(result: ModelCatalogTurnStartResult): boolean {
  return (
    result.decision === 'converged' &&
    (result.daemonOutcome === 'declined' || result.daemonOutcome === 'no-gateway')
  );
}

export interface ModelCatalogTurnStartDeps {
  /** Is this a model id the control plane currently serves as managed? A
   *  request for anything else (BYOK, a retired id, a typo) is out of scope
   *  for this lane — see the module doc. */
  isManagedModelId: (id: string) => boolean;
  lastKnown: (sessionId: string) => RunningCatalogLookup | undefined;
  /** One health GET, the same one the config/asset gates already make when
   *  cold. Fills the memo for THIS call and every later one within the TTL. */
  probe: (sessionId: string) => Promise<RunningCatalogLookup | undefined>;
  convergeCatalog: (sessionId: string) => Promise<{ outcome: string } | null>;
}

interface RunningCatalogLookup {
  ids: string[] | null;
  fallbackReason: string | null;
}

/**
 * Bring a box's managed-model provider map onto the control plane's current
 * lineup, but ONLY when the model THIS turn asked for is the one at risk.
 * NEVER throws: a turn is never refused BY THIS FUNCTION because it could not
 * run — `forwardToSandbox` decides whether `daemonOutcome` justifies a
 * refusal (see `modelCatalogRepairIncomplete`), this function only reports.
 */
export async function convergeModelCatalogBeforeTurnStart(
  sessionId: string,
  requestedManagedModelId: string | null,
  deps: ModelCatalogTurnStartDeps,
): Promise<ModelCatalogTurnStartResult> {
  try {
    if (!requestedManagedModelId || !deps.isManagedModelId(requestedManagedModelId)) {
      return { decision: 'skipped' };
    }
    let known = deps.lastKnown(sessionId);
    if (known === undefined) known = await deps.probe(sessionId).catch(() => undefined);
    if (known?.ids && known.ids.includes(requestedManagedModelId)) return { decision: 'current' };
    // Unconfirmed (`ids === null`), confirmed absent, or still unknown after
    // a probe (the box never answered) — repair eagerly. The daemon
    // re-fetches and re-diffs itself, so a call that turns out to be
    // unnecessary (the model landed between our probe and this call) costs
    // one `unchanged` response, not a wrong restart.
    const result = await deps.convergeCatalog(sessionId);
    return result ? { decision: 'converged', daemonOutcome: result.outcome } : { decision: 'unknown' };
  } catch (error) {
    logger.warn('[projects] turn-start model-catalog convergence threw', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { decision: 'unknown' };
  }
}

/**
 * Record what a health read said about this box's managed catalog. Called
 * from the SAME probe `turn-start-convergence.ts`'s `noteAssetsFromHealth`
 * already runs — never a second network call.
 */
export function noteManagedCatalogFromHealth(
  sessionId: string,
  ids: string[] | null,
  fallbackReason: string | null,
): void {
  noteRunningCatalog(sessionId, ids, fallbackReason);
}

export function defaultModelCatalogTurnStartDeps(
  isManagedModelId: (id: string) => boolean,
  probe: (sessionId: string) => Promise<RunningCatalogLookup | undefined>,
): ModelCatalogTurnStartDeps {
  return {
    isManagedModelId,
    lastKnown: lastKnownManagedCatalog,
    probe,
    convergeCatalog: async (sessionId) => convergeSandboxModelCatalog(sessionId),
  };
}
