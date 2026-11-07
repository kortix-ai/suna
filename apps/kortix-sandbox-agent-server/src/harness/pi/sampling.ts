/**
 * An agent's sampling and step limit, applied to pi's model requests.
 *
 * `temperature` and `top_p` ride on every request (`top_p` through
 * `samplingParams`, which the OpenAI-compatible gateway request carries as a
 * body field). `steps` bounds the model requests of one run: the request that
 * reaches it gets `toolChoice: 'none'`, so the model answers instead of
 * calling another tool. That is the agent's `steps` contract.
 *
 * A "run" is one turn/invocation, identified by `runId` (the prompt message id:
 * the root turn's `turnParent`, or a sub-agent invocation's `messageId`). The
 * step counter resets when `runId` changes and holds otherwise. It does NOT
 * reset on a user-role message, because compaction injects a user message
 * mid-run: keying the reset on that let a long run restart its count on every
 * compaction and so exceed `steps` without limit.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { getCurrentTools } from '@earendil-works/pi-ai'

export interface AgentSampling {
  temperature?: number
  top_p?: number
  steps?: number
  /** The current run's id (prompt message id). The step counter resets when it
   *  changes — a new user turn or a new sub-agent invocation — and holds across
   *  compaction within one run. */
  runId?: string
  /** False when the selected model refuses a non-default temperature (the catalog's `temperature`). */
  acceptsTemperature?: boolean
}

export function withAgentSampling(stream: StreamFn, sampling: () => AgentSampling): StreamFn {
  let step = 0
  let lastRunId: string | undefined
  let seenRun = false
  return (model, context, options) => {
    const { temperature, top_p, steps, runId, acceptsTemperature = true } = sampling()
    const next = { ...options }
    // A request without tools (compaction, a summary) is not a step of the run.
    if (getCurrentTools(context.messages).length) {
      // Reset at the start of a new run, not on a user-role message: compaction
      // injects one mid-run and must not restart the count.
      const newRun = !seenRun || runId !== lastRunId
      step = newRun ? 1 : step + 1
      lastRunId = runId
      seenRun = true
      if (steps !== undefined && steps > 0 && step >= steps) next.toolChoice = 'none'
    }
    if (temperature !== undefined && acceptsTemperature) next.temperature = temperature
    if (top_p !== undefined) next.samplingParams = { ...next.samplingParams, top_p }
    return stream(model, context, next)
  }
}
