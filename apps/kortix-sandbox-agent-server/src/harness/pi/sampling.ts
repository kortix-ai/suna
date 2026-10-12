/**
 * An agent's sampling and step limit, applied to pi's model requests.
 *
 * `temperature` and `top_p` ride on every request (`top_p` through
 * `samplingParams`, which the OpenAI-compatible gateway request carries as a
 * body field). `steps` bounds the model requests of one run: the request that
 * reaches it gets `toolChoice: 'none'`, so the model answers instead of
 * calling another tool — OpenCode's `steps` behavior.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { getCurrentTools } from '@earendil-works/pi-ai'

export interface AgentSampling {
  temperature?: number
  top_p?: number
  steps?: number
  /** False when the selected model refuses a non-default temperature (the catalog's `temperature`). */
  acceptsTemperature?: boolean
}

export function withAgentSampling(stream: StreamFn, sampling: () => AgentSampling): StreamFn {
  let step = 0
  return (model, context, options) => {
    const { temperature, top_p, steps, acceptsTemperature = true } = sampling()
    const next = { ...options }
    // A request without tools (compaction, a summary) is not a step of the run.
    if (getCurrentTools(context.messages).length) {
      // A run starts at a user message; every later step follows a tool result.
      step = context.messages.at(-1)?.role === 'user' ? 1 : step + 1
      if (steps !== undefined && steps > 0 && step >= steps) next.toolChoice = 'none'
    }
    if (temperature !== undefined && acceptsTemperature) next.temperature = temperature
    if (top_p !== undefined) next.samplingParams = { ...next.samplingParams, top_p }
    return stream(model, context, next)
  }
}
