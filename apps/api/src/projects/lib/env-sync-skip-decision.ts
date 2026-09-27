/**
 * Should THIS prompt's `syncSandboxEnvForPrompt` push to the daemon and wait,
 * or is the sandbox already known to be running the requested env?
 *
 * INCIDENT (2026-09-27 dev benchmark). `syncSandboxEnvForPrompt` already
 * remembered the last signature it pushed to each sandbox — see
 * `lastPromptModelSignature`/`lastPromptEnvPushAt` in `sandbox-env-sync.ts`,
 * added 2026-09-14 (#7016 T3). That memo is an in-PROCESS `Map`, and dev (and
 * prod) run the API at `desired_count = 2`. A load balancer round-robins
 * requests across replicas, so a session's turns routinely land on a
 * DIFFERENT replica than the one that pushed the previous turn's env. That
 * replica's memo is cold, so it re-POSTed `/kortix/env` and — because a real
 * secret/model/gateway change genuinely does need a full OpenCode respawn —
 * frequently re-triggered a respawn, which is what pulled the sandbox's own
 * boot sequence (managed-skill injection, runtime-asset convergence) back
 * into a window the box's log showed overlapping the send. Measured: `send →
 * model starts` at 4.9s / 2.5s / 7.0s for three back-to-back trivial prompts
 * in one session, with the daemon logging a full `[env] project env applied`
 * 3.3–5.3s after each send.
 *
 * THE FIX. `syncSandboxEnvForPrompt` now also consults a DURABLE per-session
 * record (`env-sync-durable-state.ts`, persisted on `session_sandboxes.config`
 * — survives a replica miss, a deploy, and a restart). This function is the
 * pure decision the two together produce — kept pure and dependency-free so
 * every branch is a one-line unit test, with no database or `Date.now()` to
 * fake.
 *
 * THE THREE OUTCOMES:
 *   - `push`   — the requested signature is not what THIS process, nor the
 *     durable record, last knows the sandbox to be running. This is the
 *     mandatory-synchronous case: the first prompt of a session (no memory,
 *     no durable record) and any REAL change (a secret write, a connector
 *     binding, the gateway mode, the network boundary — anything that moves
 *     `promptModelSignature`) both land here. The caller posts to the daemon
 *     and waits, exactly as it always has.
 *   - `skip` with `scheduleBackgroundRefresh: false` — the signature is
 *     confirmed current and recently confirmed. Nothing to do; the turn pays
 *     only the proxy hop.
 *   - `skip` with `scheduleBackgroundRefresh: true` — the signature is
 *     unchanged but the LAST confirmation (by either memory or the durable
 *     record) is older than `backgroundRefreshStaleMs`. The turn still never
 *     waits — the caller fires a DETACHED re-push to self-heal drift this
 *     process did not cause (a daemon restart that lost its applied env, a
 *     provider-side reset). Same reasoning as this file's neighbor
 *     `BOUNDARY_ARM_TTL_MS`.
 *
 * MEMORY BEATS THE DURABLE RECORD WHEN BOTH ARE PRESENT: memory is always at
 * least as fresh (this same process is the only writer of its own memo, and
 * every write to the durable record is preceded by the same write to memory
 * — see `sandbox-env-sync.ts`), so consulting the durable record at all once
 * memory already matches would only add a needless DB round trip.
 */

export interface EnvSyncMemoryState {
  signature: string;
  pushedAtMs: number;
}

export interface EnvSyncDurableRecord {
  signature: string;
  appliedAtMs: number;
}

export interface EnvSyncSkipDecisionInput {
  /** The signature `syncSandboxEnvForPrompt` just computed for THIS prompt. */
  signature: string;
  /** This process's own memo for the sandbox, or null if it has none. */
  memory: EnvSyncMemoryState | null;
  /**
   * The durable per-session record, or null if none exists yet (or the
   * caller chose not to look — see the "memory beats the durable record"
   * note above: a caller whose memory already matches should pass `null`
   * here rather than pay for a read).
   */
  persisted: EnvSyncDurableRecord | null;
  nowMs: number;
  /** How stale a confirmed-current record may get before a skip also asks
   *  for a background refresh. */
  backgroundRefreshStaleMs: number;
}

export type EnvSyncSkipDecision =
  | { action: 'push' }
  | { action: 'skip'; scheduleBackgroundRefresh: boolean; appliedAtMs: number };

export function decideEnvSyncAction(input: EnvSyncSkipDecisionInput): EnvSyncSkipDecision {
  const { signature, memory, persisted, nowMs, backgroundRefreshStaleMs } = input;
  const confirmed = memory?.signature === signature
    ? { appliedAtMs: memory.pushedAtMs }
    : persisted?.signature === signature
      ? { appliedAtMs: persisted.appliedAtMs }
      : null;
  if (!confirmed) return { action: 'push' };
  return {
    action: 'skip',
    scheduleBackgroundRefresh: nowMs - confirmed.appliedAtMs >= backgroundRefreshStaleMs,
    appliedAtMs: confirmed.appliedAtMs,
  };
}
