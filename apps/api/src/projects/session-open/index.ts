/**
 * Facade for the session-open orchestration.
 *
 * The former 2,185-line projects/routes/shared.ts was split along its seams
 * (KRTX-274): the orchestration lives in `session-open.ts` and its phase
 * modules, the wake fence in `resume-stopped-sandbox.ts`, and the row
 * projections in `stopped-wake-result.ts`. R4.2 moved the family out of
 * `projects/routes/`, because services import it. This file keeps every
 * exported name resolving; it holds no logic.
 */

export type {
  SessionStartResult,
  SessionStartStage,
} from '@kortix/api-contract';

export {
  sessionRuntimeUrlPath,
  serializeSandboxRow,
  stoppedWakeResult,
  sessionStartFailureFromSandbox,
  staleRuntimeWakeReason,
} from './stopped-wake-result';

export {
  RUNTIME_WAKE_CLAIM_CLEARED_KEYS,
  resumeStoppedSandbox,
  resumeStoppedSandboxByExternalId,
  isMissingRuntimeError,
} from './resume-stopped-sandbox';

export {
  ADMISSION_REPLACE_MAX_PER_WINDOW,
  ADMISSION_REPLACE_WINDOW_MS,
  allocateRuntimeOnOpen,
  claimAdmissionReplacementBudget,
  preserveEstablishedRuntimeOnOpen,
  replaceRefusedRuntimeOnOpen,
} from './session-open-provision';

export {
  markRuntimeReadyWaitStarted,
  markRuntimeWakeStarted,
} from './session-open-readiness';

export { openSession } from './session-open';
