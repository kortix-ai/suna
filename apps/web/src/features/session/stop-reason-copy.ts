import type { StopReason } from '@kortix/sdk';

/**
 * What to tell a user whose session is stopped.
 *
 * The server has always recorded WHY a box parked — a closed catalogue written
 * by every path that stops one — and the UI has never shown it. Every stop, from
 * a routine idle timeout to a boot that never came up, rendered the same
 * "<sandbox> is stopped" with a Restart button and no explanation. Incident
 * 2026-08-14 is what that costs: a session was parked because a dead tunnel
 * stopped the guest cloning, and nothing on screen could say so.
 *
 * Modelled on `lib/billing/billing-gate-state.ts`'s `billingGateCopy` — same
 * shape, same reason for existing: one place that owns the words, so a surface
 * cannot invent its own and contradict another.
 *
 * `Record<StopReason, …>` rather than a switch with a default, on purpose. The
 * catalogue is closed, so a member added to the contract and not answered here
 * is a compile error rather than a session that quietly falls back to saying
 * nothing.
 */
export interface StopReasonCopy {
  /** Replaces the generic title. Kept short — the card has a detail line. */
  title: string;
  message: string;
  /**
   * Whether restarting is expected to help.
   *
   * Advisory for COPY only. Whether the button renders is the server's call
   * (`retriable` on the start result); this decides whether the words invite a
   * retry or explain why one will not help.
   */
  restartLikelyHelps: boolean;
}

const COPY: Record<StopReason, StopReasonCopy> = {
  deadline_expired: {
    title: 'Session timed out',
    message:
      'This session reached its time limit and its computer was stopped. Restarting brings it back with your files as you left them.',
    restartLikelyHelps: true,
  },
  run_cap: {
    title: 'Session hit its run limit',
    message:
      'This session ran continuously for the maximum allowed stretch and was stopped. Restarting begins a fresh stretch.',
    restartLikelyHelps: true,
  },
  idle_grace: {
    title: 'Stopped after going idle',
    message:
      'Nothing was running for a while, so this session’s computer was stopped to stop it costing you compute. Restarting brings it back.',
    restartLikelyHelps: true,
  },
  boot_floor_expired: {
    title: 'Stopped before it was used',
    message:
      'This session’s computer started but nothing ran on it, so it was stopped again. Restarting brings it back.',
    restartLikelyHelps: true,
  },
  provider_reconcile: {
    title: 'Computer was stopped',
    message:
      'The cloud provider reported this session’s computer as stopped, and we matched our record to it. Restarting brings it back.',
    restartLikelyHelps: true,
  },
  provider_removed: {
    title: 'Computer was removed',
    message:
      'The cloud provider no longer has this session’s computer. It cannot be restarted. Anything committed and pushed is safe in your project’s repository.',
    restartLikelyHelps: false,
  },
  runtime_wake_failed: {
    title: 'Computer could not wake up',
    message:
      'This session’s computer was parked and did not come back when we tried to wake it. Restarting tries again.',
    restartLikelyHelps: true,
  },
  runtime_boot_failed: {
    title: 'Computer could not finish starting',
    message:
      'The machine came up but the agent runtime never became reachable inside it — often a network or repository-access problem rather than the machine itself. Restarting tries again.',
    restartLikelyHelps: true,
  },
  restart_failed: {
    title: 'Restart did not complete',
    message:
      'The last restart could not bring this session’s computer back up. Trying again is usually worth it; if it keeps failing, the runtime is not reachable.',
    restartLikelyHelps: true,
  },
  provisioning_stalled: {
    title: 'Computer never finished setting up',
    message:
      'Setting up this session’s computer stalled and it was never usable. Restarting provisions a new one.',
    restartLikelyHelps: true,
  },
  unusable_runtime_state: {
    title: 'Session and computer got out of step',
    message:
      'This session’s record and its computer disagreed about what state they were in, so the computer was stopped. Restarting reconciles them.',
    restartLikelyHelps: true,
  },
  manual: {
    title: 'Session was stopped',
    message: 'Someone stopped this session. Restarting brings its computer back.',
    restartLikelyHelps: true,
  },
  wedged_backlog_remediation: {
    title: 'Stopped by maintenance',
    message:
      'This session’s computer was stuck and was cleared by a maintenance sweep — not by anything you did. Restarting brings it back.',
    restartLikelyHelps: true,
  },
};

/**
 * Copy for a recorded stop reason, or null when there is none.
 *
 * Null is the ordinary case, not an error: a live box has no stop to explain,
 * and a row parked before `stop_reason` reached the wire has nothing recorded.
 * Callers fall back to their existing generic copy — this only ever adds
 * detail, it never removes a surface.
 */
export function stopReasonCopy(reason: StopReason | null | undefined): StopReasonCopy | null {
  if (!reason) return null;
  return COPY[reason] ?? null;
}
