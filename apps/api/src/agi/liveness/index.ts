/**
 * AGI liveness (spec §8, R-28 … R-33).
 *
 * Deliberately does NOT import ./routes: the session-lifecycle terminal paths
 * import {@link recordSessionOutcomeBestEffort} from here, and pulling the route
 * module in would drag `agiApp` — and the whole Hono app — into that import
 * graph. Route registration stays a side-effect import in ../index.ts, the same
 * shape the task routes use.
 */
export {
  recordSessionOutcome,
  recordSessionOutcomeBestEffort,
  type SessionClaimOutcome,
  type SessionOutcome,
} from './session-outcome';
export {
  LIVENESS_TASK_CAP,
  resolveWorkspaceLiveness,
  serializeLivenessView,
  serializeSweepOutcome,
  sweepWorkspaceLiveness,
  type SweepResult,
  type TaskLivenessView,
  type WorkspaceLiveness,
} from './surface';
export { applyBoundedRecovery, type BoundedRecoveryResult } from './recovery';
export {
  LIVENESS_STATES,
  STALL_REASONS,
  classifyClaimProgress,
  classifyClaimSession,
  isRecoverableStall,
  isStallFingerprint,
  nextRecoveryStep,
  resolveTaskLiveness,
  serializeTaskLiveness,
  stallFingerprint,
  type LivenessState,
  type PendingRequestRef,
  type StallReason,
  type TaskLiveness,
} from './wire';
