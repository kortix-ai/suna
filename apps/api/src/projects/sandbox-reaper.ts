/**
 * The sandbox reaper / compute-metering subsystem, as one import surface.
 *
 * The implementation lives in ./reaping (one module per DECISION, not per cron
 * slot) and in ../billing (the metering half, which was only ever here because
 * it shares a maintenance tick). This file exists so the many call sites —
 * maintenance.ts, the provider webhook ingress, account deletion, the e2e
 * suites — keep the import path they already had.
 *
 *   ./reaping/policy               the reconcile decision + error classifiers
 *   ./reaping/box-reaper           the running-box sweep (deadline_at <= now)
 *   ./reaping/box-queries          the sweep's DB reads/writes
 *   ./reaping/orphan-boxes         provider boxes with no DB row
 *   ./reaping/stuck-sessions       sessions stuck ACTIVE with no live box
 *   ./reaping/sandbox-state-sync   the single stop writer + webhook reconcilers
 *   ../billing/services/compute-close-policy    what to close, and bill until when
 *   ../billing/services/compute-invariant-sweep the enforcer + its two monitors
 *
 * `reconcileUndeliveredPrompts` is deliberately NOT re-exported here: it moved to
 * ./session-lifecycle (it drains the command queue — nothing to do with sandboxes
 * or billing), and re-exporting it would statically pull the whole lifecycle
 * engine into every reaper consumer, which is the exact cycle that move deleted.
 */

export { REAP_BATCH_SIZE, reapBatchSize } from './reaper-constants';

export {
  type ReconcileAction,
  decideReconcile,
  isAlreadyNotRunning,
} from './reaping/policy';

export {
  type ReapResult,
  EMPTY_REAP_RESULT,
  observeSandboxTurn,
  reapAndReconcileSandboxes,
} from './reaping/box-reaper';

export { type OrphanReapResult, reapOrphanProviderBoxes } from './reaping/orphan-boxes';

export {
  type EnvironmentReapDecision,
  type EnvironmentReapResult,
  ENVIRONMENT_DELETE_HORIZON_MS,
  ENVIRONMENT_IDLE_HORIZON_MS,
  decideEnvironmentReaping,
  reapOrphanEnvironments,
} from './reaping/orphan-environments';

export { reconcileStuckActiveSessions } from './reaping/stuck-sessions';

export {
  reconcileSandboxRemovedByExternalId,
  reconcileSandboxStoppedByExternalId,
} from './reaping/sandbox-state-sync';

export {
  type ComputeCloseReason,
  computeCloseWindowEnd,
  decideComputeClose,
  hasFailedRuntimeStart,
} from '../billing/services/compute-close-policy';

export {
  type OrphanComputeResult,
  countBillingInvariantViolations,
  countStaleLivenessWindows,
  reconcileOrphanComputeSessions,
} from '../billing/services/compute-invariant-sweep';
