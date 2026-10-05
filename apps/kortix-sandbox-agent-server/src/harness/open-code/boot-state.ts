import type { SandboxBootState } from '../contract/boot-state'

export interface OpenCodeBootState extends SandboxBootState {
  /** True when boot must create a first OpenCode conversation before the UI is usable. */
  initialRuntimeSessionRequired?: boolean
  /** OpenCode session id created during boot, if one was requested. */
  initialRuntimeSessionId?: string | null
  /** When THIS boot delivered the first prompt (`prompt_async` answered). Unset
   *  when the prompt was already delivered by an earlier boot of this box. */
  initialPromptDeliveredAtMs?: number | null
  /** Boot-time OpenCode session creation failure. */
  initialRuntimeSessionError?: string | null
  /** Fatal local persistence failure in the OpenCode audit relay. */
  auditRelayError?: string | null
}
