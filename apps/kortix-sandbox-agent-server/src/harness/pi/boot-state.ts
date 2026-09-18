import type { SandboxBootState } from '../../boot-state'

/**
 * pi's boot state. The three session fields keep the OpenCode names on
 * purpose: `/kortix/health` reports `opencode_session_id` and the API's
 * readiness readers key on that field regardless of which harness answers.
 */
export interface PiBootState extends SandboxBootState {
  /** True when boot must claim the pending first turn before the UI is usable. */
  initialOpenCodeSessionRequired?: boolean
  /** The pi root id once the session is usable (and its first prompt, if any, admitted). */
  initialOpenCodeSessionId?: string | null
  /** Boot-time session setup failure. */
  initialOpenCodeSessionError?: string | null
}
