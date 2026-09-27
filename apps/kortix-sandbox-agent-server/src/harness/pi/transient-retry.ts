/**
 * Kortix-owned retry of a model step that failed on a transient provider error.
 *
 * pi's AgentSession retry is off (extensions/host.ts): Kortix owns it, so the
 * wire can show OpenCode's `retry` status instead of a terminal error. Without
 * this, one cut stream ("Stream ended without finish_reason", "terminated",
 * a 5xx, a rate limit) ended the whole turn, and a trigger or factory loop
 * stopped on it.
 *
 * The classifier is pi-ai's own (`isRetryableAssistantError`): network and
 * stream cuts, 408/429/5xx, overload and timeouts retry; quota, billing and
 * other 4xx do not. A context overflow never retries.
 *
 * A retry drops the failed assistant message from the agent's context (it is
 * never sent to the model again) and continues from the last user or tool
 * result, the same as pi's own `_prepareRetry`. Bounded: 5 retries on an
 * exponential backoff capped at 30 s (2, 4, 8, 16, 30 s by default).
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { type AssistantMessage, isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai'

export const TURN_RETRY_MAX_ATTEMPTS = 5
export const TURN_RETRY_MAX_DELAY_MS = 30_000

/** OpenCode's `SessionStatus` for a step that waits to retry. The SDK counts it as busy. */
export interface RetryPlan {
  attempt: number
  message: string
  /** Epoch ms of the next attempt. */
  next: number
  delayMs: number
}

/** The agent surface a retry needs: pi-agent-core's `Agent`. */
export interface RetryableAgent {
  state: { messages: AgentMessage[] }
  continue(): Promise<void>
}

export class TransientRetry {
  private attempts = 0
  private aborted = false
  private sleeping: AbortController | null = null

  constructor(
    private readonly opts: {
      baseDelayMs: number
      contextWindow: () => number
      now: () => number
    },
  ) {}

  /**
   * The retry this failed message gets, or null. Pure until `run` takes it:
   * the wire asks at `agent_end` and `run` asks after the step, and both see
   * the same answer.
   */
  plan(message: AgentMessage | undefined): RetryPlan | null {
    if (this.aborted || this.attempts >= TURN_RETRY_MAX_ATTEMPTS) return null
    if (!message || message.role !== 'assistant') return null
    const assistant = message as AssistantMessage
    if (!isRetryableAssistantError(assistant) || isContextOverflow(assistant, this.opts.contextWindow())) return null
    const attempt = this.attempts + 1
    const delayMs = Math.min(this.opts.baseDelayMs * 2 ** (attempt - 1), TURN_RETRY_MAX_DELAY_MS)
    return { attempt, delayMs, next: this.opts.now() + delayMs, message: assistant.errorMessage || 'The model request failed' }
  }

  get wasAborted(): boolean {
    return this.aborted
  }

  /** Stop retrying: a pending backoff ends now and no further step starts. */
  abort(): void {
    this.aborted = true
    this.sleeping?.abort()
  }

  /**
   * Run `first`, then continue the agent after each transient failure until a
   * step succeeds, fails for good, the budget is spent, or `abort` is called.
   */
  async run(agent: RetryableAgent, first: () => Promise<void>): Promise<void> {
    await first()
    for (;;) {
      const plan = this.plan(agent.state.messages.at(-1))
      if (!plan) return
      this.attempts = plan.attempt
      if (!(await this.sleep(plan.delayMs))) return
      agent.state.messages = agent.state.messages.slice(0, -1)
      await agent.continue()
    }
  }

  private async sleep(ms: number): Promise<boolean> {
    if (this.aborted) return false
    const controller = new AbortController()
    this.sleeping = controller
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    } finally {
      this.sleeping = null
    }
    return !this.aborted
  }
}
