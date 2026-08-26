/**
 * The session-open envelope: what `POST …/sessions/:sid/start` DID on this call
 * and what it OBSERVED, stamped onto every payload the open path returns.
 *
 * WHY THIS EXISTS. A live capture on 2026-08-26 (session 9c8749ac, box
 * i67m4fhw2t3nesssgl4yf) showed `/start` answering, on every open for 10+ hours:
 *
 *   {"stage":"failed","retriable":false,
 *    "metadata":{"stopReason":"runtime_boot_failed","initStatus":"ready",
 *                "healthStatus":"unknown","initAttempts":1,"initMaxAttempts":3,
 *                "lastInitError":null,"stoppedAt":"…T11:57:09Z","warm":true}}
 *
 * Four fields from four different writes, none of them describing what THIS
 * call did — which was nothing at all: no provider was contacted. The client
 * cannot tell "we checked and it is broken" from "we replayed a stamp".
 *
 * The envelope fixes that at the source rather than with a serializer:
 *
 *  - `observed_at` — ONE clock for the whole answer.
 *  - `action`      — what the server did (there is no `replayed_stamp`).
 *  - `observation` — what it asked and what came back, `known:false` when it
 *                    did not ask. `known:false` is never "checked and unknown".
 *  - `boot`        — which phase, since when, and whether anything is DRIVING
 *                    the box right now (`actively_starting`).
 *  - `failure.evidence` — a negative is a claim: which check, when, what error,
 *                    how many attempts, and when the server retries by itself.
 *
 * `retriable` stays DERIVED per call. Nothing here reads a persisted verdict.
 */

import type {
  SessionStartAction,
  SessionStartBoot,
  SessionStartBootPhase,
  SessionStartObservation,
  SessionStartResult,
} from '@kortix/api-contract';
import { runtimeWakeInProgress } from './runtime-wake-fence';

/** Later, more specific actions win. `inspected` never overwrites a real one. */
const ACTION_RANK: Record<SessionStartAction, number> = {
  inspected: 0,
  checked_provider: 1,
  awaited_wake: 2,
  cooling_down: 2,
  reconciled: 3,
  restored: 4,
  resumed: 4,
  provisioned: 4,
};

export type ObservedRuntimeState = 'ready' | 'booting' | 'unreachable';

export interface StartCallLog {
  readonly observedAt: Date;
  /** Record what this call DID. Highest-ranked action wins. */
  did(action: SessionStartAction): void;
  /** Record a provider status this call actually read. */
  sawProvider(status: string | null): void;
  /** Record a daemon verdict this call actually earned. */
  sawRuntime(state: ObservedRuntimeState, bootPhase?: string | null): void;
  readonly action: SessionStartAction;
  readonly observation: SessionStartObservation;
}

export function createStartCallLog(observedAt: Date = new Date()): StartCallLog {
  let action: SessionStartAction = 'inspected';
  let providerStatus: string | null = null;
  let providerCheckedAt: string | null = null;
  let runtimeState: ObservedRuntimeState | null = null;
  let runtimeBootPhase: string | null = null;
  let runtimeCheckedAt: string | null = null;

  return {
    observedAt,
    did(next) {
      if (ACTION_RANK[next] >= ACTION_RANK[action]) action = next;
    },
    sawProvider(status) {
      providerStatus = status;
      providerCheckedAt = new Date().toISOString();
      if (ACTION_RANK.checked_provider >= ACTION_RANK[action]) action = 'checked_provider';
    },
    sawRuntime(state, bootPhase) {
      runtimeState = state;
      runtimeBootPhase = bootPhase ?? null;
      runtimeCheckedAt = new Date().toISOString();
    },
    get action() {
      return action;
    },
    get observation(): SessionStartObservation {
      return {
        provider: {
          known: providerCheckedAt !== null,
          status: providerStatus,
          checked_at: providerCheckedAt,
        },
        runtime: {
          known: runtimeCheckedAt !== null,
          state: runtimeState,
          boot_phase: runtimeBootPhase,
          checked_at: runtimeCheckedAt,
        },
      };
    },
  };
}

/** Reasons that mean "a provider operation is moving this box", not "booting". */
const RESUMING_REASONS = new Set([
  'runtime_waking',
  'runtime_wake_cooldown',
  'runtime_status_unknown',
  'runtime_stop_unconfirmed',
  'runtime_restoring_in_place',
  'runtime_recovered_in_place',
  'runtime_recovery_in_progress',
  'runtime_removed_checking',
]);

function firstTimestamp(
  metadata: Record<string, unknown>,
  ...keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

export function deriveBootPhase(result: SessionStartResult): SessionStartBootPhase {
  switch (result.stage) {
    case 'ready':
      return 'ready';
    case 'provisioning':
      return 'provisioning';
    case 'stopped':
      return 'parked';
    case 'failed':
      return 'failed';
    default:
      return result.reason && RESUMING_REASONS.has(result.reason) ? 'resuming' : 'booting';
  }
}

export function deriveBoot(
  result: SessionStartResult,
  metadata: Record<string, unknown>,
  action: SessionStartAction,
  now: Date,
): SessionStartBoot {
  const phase = deriveBootPhase(result);
  const identityState = metadata.runtimeIdentityState;
  const initStatus = metadata.initStatus;
  // Is anything DRIVING this box right now? The input RC-3 lacked: a parked box
  // whose client keeps polling must be able to tell "a wake is running" from
  // "nothing is happening and nothing will unless you ask".
  const activelyStarting =
    action === 'resumed' ||
    action === 'restored' ||
    action === 'provisioned' ||
    runtimeWakeInProgress(metadata, now) ||
    identityState === 'recovering' ||
    identityState === 'recovery_claimed' ||
    (result.stage === 'provisioning' && (initStatus === 'provisioning' || initStatus === 'retrying' || initStatus === 'pending'));

  const since =
    phase === 'ready'
      ? firstTimestamp(metadata, 'providerRunningConfirmedAt', 'initSucceededAt')
      : phase === 'resuming'
        ? firstTimestamp(metadata, 'runtimeWakeProgressAt', 'runtimeWakeStartedAt', 'stoppedAt')
        : phase === 'booting'
          ? firstTimestamp(
              metadata,
              'opencodeBootWaitFirstSeenAt',
              'opencodeReadyWaitStartedAt',
              'providerRunningConfirmedAt',
            )
          : phase === 'provisioning'
            ? firstTimestamp(metadata, 'initUpdatedAt', 'initStartedAt')
            : firstTimestamp(metadata, 'runtimeStartFailedAt', 'runtimeWakeFailedAt', 'stoppedAt');

  return { phase, since, actively_starting: activelyStarting };
}

/**
 * Stamp the envelope onto one payload. Pure: the caller owns the log and the
 * row, so every branch of the open path gets a coherent answer without each
 * `return` site having to remember to build one.
 */
export function withStartEnvelope(
  result: SessionStartResult,
  log: StartCallLog,
  metadata: Record<string, unknown> = {},
): SessionStartResult {
  return {
    ...result,
    observed_at: log.observedAt.toISOString(),
    action: log.action,
    observation: log.observation,
    boot: deriveBoot(result, metadata, log.action, log.observedAt),
  };
}
