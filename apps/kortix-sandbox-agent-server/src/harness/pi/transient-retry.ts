/**
 * Kortix-owned retry of a model step that failed on a transient provider error.
 *
 * pi's AgentSession retry is off (extensions/host.ts): Kortix owns it, so the
 * wire can show OpenCode's `retry` status instead of a terminal error. Without
 * this, one cut stream ("Stream ended without finish_reason", "terminated",
 * a 5xx, a rate limit) ended the whole turn, and a trigger or factory loop
 * stopped on it.
 *
 * Classifier: pi-ai's own `isRetryableAssistantError` (network and stream
 * cuts, 408/429/5xx, overload, timeouts), plus the upstream shapes it misses
 * (`TRANSIENT_EXTRA`). Quota, billing and other 4xx never retry; a context
 * overflow never retries.
 *
 * A retry drops the failed assistant message from the agent's context (it is
 * never sent to the model again) and continues from the last user or tool
 * result, the same as pi's own `_prepareRetry`. The root's context is pi's
 * session store, so the root passes its own `dropFailed` (runtime.ts). Two bounded phases, one
 * schedule (default base 2 s):
 *   - in-turn retries: 5 attempts at 2, 4, 8, 16, 30 s (~60 s) for a blip;
 *   - resumes: 3 more at 60, 120, 240 s (~7 min) for an outage.
 * Only an error that outlasts both ends the turn.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { type AssistantMessage, isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai'

/** In-turn retries: base * 2^(n-1), capped at 15 * base (2, 4, 8, 16, 30 s). */
export const TURN_RETRY_ATTEMPTS = 5
/** Resumes after the retries: 30, 60, 120 * base (60, 120, 240 s). */
export const TURN_RESUME_FACTORS = [30, 60, 120] as const
export const TURN_RETRY_MAX_ATTEMPTS = TURN_RETRY_ATTEMPTS + TURN_RESUME_FACTORS.length

/** The backoff before attempt `attempt` (1-based) for a base delay. */
export function retryDelayMs(attempt: number, baseDelayMs: number): number {
  if (attempt <= TURN_RETRY_ATTEMPTS) return Math.min(baseDelayMs * 2 ** (attempt - 1), baseDelayMs * 15)
  return baseDelayMs * TURN_RESUME_FACTORS[attempt - TURN_RETRY_ATTEMPTS - 1]!
}

/**
 * Transient shapes pi-ai's classifier misses: a stream cut mid data-line
 * surfaces as a JSON parse error ("JSON Parse error: Unable to parse JSON
 * string", "JSON parsing failed: Text: {...", "Could not parse message into
 * JSON", and since pi-ai 1.0 "Error reading response: malformed server-sent
 * event JSON."); a gateway availability error reads "<model> is temporarily
 * unavailable"; Bun's fetch timeout reads "The operation timed out".
 */
const TRANSIENT_EXTRA = /json pars(e|ing)|unable to parse json|parse message into json|malformed server-sent event|temporarily unavailable|timed? ?out/i
/** Account limits are never transient, whatever else the text says. */
const PERMANENT = /insufficient_quota|quota exceeded|out of budget|billing|usage limit|available balance/i

export function isTransientModelError(message: AssistantMessage): boolean {
  if (message.stopReason !== 'error') return false
  const text = message.errorMessage ?? ''
  if (PERMANENT.test(text)) return false
  return isRetryableAssistantError(message) || TRANSIENT_EXTRA.test(text)
}

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
    if (!isTransientModelError(assistant) || isContextOverflow(assistant, this.opts.contextWindow())) return null
    const attempt = this.attempts + 1
    const delayMs = retryDelayMs(attempt, this.opts.baseDelayMs)
    return { attempt, delayMs, next: this.opts.now() + delayMs, message: assistant.errorMessage || 'The model request failed' }
  }

  /** A failed step was continued at least once: the steps after it run outside pi's prompt loop. */
  get retried(): boolean {
    return this.attempts > 0
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
  async run(
    agent: RetryableAgent,
    first: () => Promise<void>,
    dropFailed: () => void = () => {
      agent.state.messages = agent.state.messages.slice(0, -1)
    },
  ): Promise<void> {
    await first()
    for (;;) {
      const plan = this.plan(agent.state.messages.at(-1))
      if (!plan) return
      this.attempts = plan.attempt
      if (!(await this.sleep(plan.delayMs))) return
      dropFailed()
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
