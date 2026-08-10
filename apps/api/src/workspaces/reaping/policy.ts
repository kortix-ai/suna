/**
 * The reaper's PURE decisions — the reconcile action and the error classifiers.
 *
 * Deliberately free of `db`, provider adapters, and every other side effect, so
 * the money semantics can be exhaustively unit-tested without booting the
 * platform layer, and so a stop path (session-lifecycle/stop.ts) can reuse the
 * error classifiers without importing the sweep engine — which is what used to
 * make this an import cycle.
 *
 * WHAT USED TO BE HERE, AND WHY IT IS GONE
 * ----------------------------------------
 * Until 2026-07-29 this file also held the TTL knobs, two activity clocks, an
 * arm/disarm idle state machine, and an "absolute ceiling" computed from
 * usage_events. Every one of them was a heuristic reconstructing a fact the
 * control plane could simply have recorded: WHEN THIS BOX SHOULD DIE. Two of
 * them (`lastMeaningfulAt`, and the busy probe they fed) read timestamps the
 * SANDBOX ITSELF wrote, so a wedged box forged the evidence used to judge it and
 * lived forever — 187 genuinely running prod boxes, 156 of which had never
 * emitted a single LLM usage_event, the oldest 264 hours old.
 *
 * The replacement is one column, `session_sandboxes.deadline_at`, written only
 * by apps/api/src/projects/sandbox-deadline.ts and bounded by a DB CHECK. The
 * decision for a running box is now `deadline_at <= now()`. There is nothing
 * left here to reconstruct.
 */

import type { SandboxStatus } from '../../platform/providers/status';

export type ReconcileAction = 'none' | 'reconcile-stopped' | 'reconcile-removed';

/**
 * Pure reconcile decision for a box the provider says is NOT running.
 * (Running boxes take the deadline path.) 'unknown' is a transient provider
 * error or a transitional state (starting/resuming/migrating) — NEVER act on
 * uncertainty; acting could kill a healthy box or fight a wake.
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
