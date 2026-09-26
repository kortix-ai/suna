import type { SandboxBootState } from '../../boot-state'

export interface OpenCodeBootState extends SandboxBootState {
  /** True when boot must create a first OpenCode conversation before the UI is usable. */
  initialOpenCodeSessionRequired?: boolean
  /** OpenCode session id created during boot, if one was requested. */
  initialOpenCodeSessionId?: string | null
  /** When THIS boot delivered the first prompt (`prompt_async` answered). Unset
   *  when the prompt was already delivered by an earlier boot of this box. */
  initialPromptDeliveredAtMs?: number | null
  /** Boot-time OpenCode session creation failure. */
  initialOpenCodeSessionError?: string | null
  /** Fatal local persistence failure in the OpenCode audit relay. */
  auditRelayError?: string | null
}
