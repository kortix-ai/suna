/**
 * The reaper's PURE decisions — TTL knobs, activity clocks, error classifiers,
 * and the kill decision itself.
 *
 * Deliberately free of `db`, provider adapters, and every other side effect, so
 * the money semantics can be exhaustively unit-tested without booting the
 * platform layer, and so a stop path (session-lifecycle/stop.ts) can reuse the
 * error classifiers without importing the sweep engine — which is what used to
 * make this an import cycle.
 */

import { config } from '../../config';
import type { SandboxStatus } from '../../platform/providers/status';
import { positiveEnvInt } from '../reaper-constants';

const DEFAULT_AUTOSTOP_MINUTES = 15;
const DEFAULT_TRIGGER_AUTOSTOP_MINUTES = 5;
/** Absolute ceiling: no box survives this long without PROVEN activity. */
const DEFAULT_HARD_STOP_MINUTES = 240;

/** The single knob for "how long with no real turn before we stop a box". */
export function autoStopTtlMs(): number {
  const min = Math.max(1, config.KORTIX_SANDBOX_AUTOSTOP_MINUTES || DEFAULT_AUTOSTOP_MINUTES);
  return min * 60_000;
}

/**
 * THE BACKSTOP — the answer to "a box must NEVER run 24/7 when it is not in use".
 *
 * Every other liveness signal the reaper trusts is written by the box itself:
 * `metadata.executionLeaseUntil` is stamped by the in-sandbox agent's heartbeat
 * (execution-lease.ts `writeExecutionLease`, renewed every 60s while it believes
 * ANY opencode session is 'busy' OR 'retry'), and the busy probe asks that same
 * wedged daemon. A retry loop, a dropped opencode event subscription, or any
 * daemon wedge therefore renews its own reprieve forever — measured live
 * 2026-07-29: 188 of 279 active prod boxes held a live execution lease, 182 of
 * them older than 12h, and `metadata.idleObservedAt` was a JSON null on EVERY
 * row platform-wide because the lease veto returns before the arm write and
 * every lease renew force-nulls it. The idle-TTL stop path had never fired in
 * production, not once. (That renew also stamped `lastTurnAt`, letting the box
 * forge the very clock below; removed 2026-07-29 together with the cumulative
 * lease ceiling in execution-lease.ts, which bounds the veto itself.)
 *
 * So the ceiling below deliberately consults ONLY evidence the box cannot forge:
 * the sandbox row's creation time and real `usage_events` rows (see
 * `provenActivityAt`). Past this ceiling the box is stopped regardless of the
 * lease, regardless of the busy probe. A probe veto must never be unbounded.
 */
export function hardStopCeilingMs(): number {
  return Math.max(
    autoStopTtlMs(),
    positiveEnvInt('KORTIX_SANDBOX_HARD_STOP_MINUTES', DEFAULT_HARD_STOP_MINUTES) * 60_000,
  );
}

/** Kill switch for the absolute ceiling. Default ON — enforcement is the default. */
export function hardStopEnabled(): boolean {
  return process.env.KORTIX_SANDBOX_HARD_STOP_ENABLED !== 'false';
}

/** Shorter idle window for trigger-fired boxes — no human is waiting on them,
 *  so every idle minute past turn end is pure billed dead time. */
export function triggerAutoStopTtlMs(): number {
  const min = Math.max(1, config.KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES || DEFAULT_TRIGGER_AUTOSTOP_MINUTES);
  return min * 60_000;
}

/** Sandbox rows carry the session's invocation source in `metadata.source`
 *  (stamped at provisioning). 'trigger:*' boxes are unattended; anything else
 *  (ui/slack/cli/missing) is treated as interactive — the safe direction. */
export function isTriggerSession(metadata: Record<string, unknown> | null): boolean {
  const source = metadata?.source;
  return typeof source === 'string' && source.startsWith('trigger:');
}

/** When the reaper first OBSERVED the box idle (probe-confirmed). Null when
 *  never observed / cleared by a busy observation or an explicit resume. */
export function idleObservedAtOf(metadata: Record<string, unknown> | null): Date | null {
  const raw = metadata?.idleObservedAt;
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type IdleConfirmAction = 'arm' | 'wait' | 'stop';

/**
 * The idle TTL counts from OBSERVED idleness, not from the last LLM call —
 * the last usage_event can predate the real turn end by however long the
 * final tool run takes, and stopping "TTL after last LLM call" could kill a
 * box seconds after its turn actually finished. So the first probe-confirmed
 * idle observation only ARMS the timer; the stop fires once the box has
 * stayed observably idle for the full TTL, and any busy observation disarms.
 * Pure so the money semantics are exhaustively unit-tested.
 */
export function decideIdleConfirm(input: {
  idleObservedAt: Date | null;
  now: Date;
  ttlMs: number;
}): IdleConfirmAction {
  const { idleObservedAt, now, ttlMs } = input;
  if (!idleObservedAt || idleObservedAt.getTime() > now.getTime()) return 'arm';
  return now.getTime() - idleObservedAt.getTime() >= ttlMs ? 'stop' : 'wait';
}

export type ReconcileAction = 'none' | 'reconcile-stopped' | 'reconcile-removed';

/**
 * Pure reconcile decision for a box the provider says is NOT running.
 * (Running boxes take the probe path: busy → alive, observed idle for the
 * TTL → stop.) 'unknown' is a transient provider error or a transitional
 * state (starting/resuming/migrating) — NEVER act on uncertainty; acting
 * could kill a healthy box or fight a wake.
 */
export function decideReconcile(providerStatus: SandboxStatus): ReconcileAction {
  // The provider currently reports the external box gone. Preserve its identity
  // and stop billing; a later explicit open may retry that same sandbox.
  if (providerStatus === 'removed') return 'reconcile-removed';
  // Provider already stopped/archived it (its own auto-stop, an admin, or a
  // webhook we missed) but our row still says active — reconcile + close billing.
  if (providerStatus === 'stopped') return 'reconcile-stopped';
  // TERMINAL — the box is dead and will never run again (Daytona `error`,
  // Platinum `failed`). Until 2026-07-29 this arrived here as 'unknown' and was
  // treated as transient uncertainty forever, so the row stayed `active` and its
  // compute window billed wall-clock against a box that had not existed for
  // weeks. A terminal state is as actionable as a stop: reconcile and close.
  if (providerStatus === 'terminal') return 'reconcile-stopped';
  return 'none';
}

/**
 * Last MEANINGFUL activity for a sandbox row. Driven by `metadata.lastTurnAt`
 * with a fallback to row creation so a never-used box still ages out after the
 * grace TTL. Deliberately does NOT consider `last_used_at` (proxy traffic) or
 * any passive signal.
 *
 * Since 2026-07-29 `lastTurnAt` is written ONLY by control-plane-observed
 * events — the reaper's own busy probe (reaping/running-box.ts), an explicit
 * wake (routes/shared.ts), an in-place restart (session-lifecycle/
 * readiness-clocks.ts). The in-sandbox lease renew used to stamp it too, which
 * meant a wedged daemon kept this clock permanently fresh and could never age
 * out; the whole point of the clock is that the box cannot wind it forward.
 */
export function lastMeaningfulAt(row: {
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}): Date {
  const stamped = row.metadata && typeof row.metadata.lastTurnAt === 'string'
    ? new Date(row.metadata.lastTurnAt as string)
    : null;
  if (stamped && !Number.isNaN(stamped.getTime())) {
    return stamped.getTime() >= row.createdAt.getTime() ? stamped : row.createdAt;
  }
  return row.createdAt;
}

/**
 * The UNFORGEABLE activity clock, and the only input to the absolute ceiling.
 *
 * `lastMeaningfulAt` above reads `metadata.lastTurnAt`, which until 2026-07-29
 * the in-sandbox agent rewrote to `now` on every 60s execution-lease renew — so
 * a wedged box kept its own activity clock permanently fresh and could never age
 * out. That stamp is gone, but this function stays the load-bearing one: it
 * reads only signals the box cannot write to at all:
 *
 *   - `createdAt` — when WE provisioned the row, and
 *   - the newest `usage_events` row for the session — a real LLM call, written
 *     by the gateway on the API side.
 *
 * A box with no LLM call since it was created is not running an agent turn, no
 * matter what its own daemon reports.
 */
export function provenActivityAt(
  row: { createdAt: Date },
  lastUsageAt: Date | null,
): Date {
  if (lastUsageAt && !Number.isNaN(lastUsageAt.getTime()) && lastUsageAt.getTime() > row.createdAt.getTime()) {
    return lastUsageAt;
  }
  return row.createdAt;
}

/**
 * The absolute stop decision. True → stop the box NOW, bypassing the execution
 * lease and the busy probe. `provenActivityAt` must come from
 * `provenActivityAt()` above; passing a box-authored timestamp here would
 * reintroduce the exact unbounded-veto bug this exists to kill.
 * Pure so the money semantics are exhaustively unit-tested.
 */
export function decideHardStop(input: {
  provenActivityAt: Date | null;
  now: Date;
  ceilingMs: number;
  enabled?: boolean;
}): boolean {
  const { provenActivityAt: proven, now, ceilingMs } = input;
  // Never act on uncertainty: a failed usage lookup yields null and must not
  // stop anything (the caller passes null in that case, deliberately).
  if (input.enabled === false || !proven) return false;
  if (Number.isNaN(proven.getTime()) || proven.getTime() > now.getTime()) return false;
  return now.getTime() - proven.getTime() >= ceilingMs;
}

export function isLifecycleTransitionInProgress(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('state change in progress') || msg.includes('transition in progress');
}

export function isAlreadyNotRunning(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('not started') ||
    msg.includes('not running') ||
    msg.includes('already stopped') ||
    msg.includes('not found')
  );
}

/**
 * The metadata patch written when the reaper stops a box. `quiesce` marks an
 * idle-stop so passive traffic can't resurrect it (only an explicit open / new
 * turn clears it). Stopping never authorizes replacing a data-bearing runtime.
 */
export function buildIdleStopMetadata(opts: { quiesce: boolean; nowIso: string }): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (opts.quiesce) {
    meta.idleQuiesced = true;
    meta.idleQuiescedAt = opts.nowIso;
  }
  return meta;
}
