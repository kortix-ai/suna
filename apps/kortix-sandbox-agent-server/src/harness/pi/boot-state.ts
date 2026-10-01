import type { SandboxBootState } from '../contract/boot-state'

/**
 * pi's boot state. `/kortix/health` reports the session fields in its
 * `harness.session` block (and the pre-W3 flat names, from `legacy-names.ts`).
 */
export interface PiBootState extends SandboxBootState {
  /** True when boot must claim the pending first turn before the UI is usable. */
  initialRuntimeSessionRequired?: boolean
  /** The pi root id once the session is usable (and its first prompt, if any, admitted). */
  initialRuntimeSessionId?: string | null
  /** Boot-time session setup failure. */
  initialRuntimeSessionError?: string | null
  /** The audit relay could not start or persist; the runtime reports unhealthy. */
  auditRelayError?: string | null
}
