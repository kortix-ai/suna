import type { KortixGatewayModel } from '@kortix/api-contract/fallback-models'

// The composer's Thinking control lists `Object.keys(model.variants)` and sends
// the pick as `variant` on the prompt; the harness resolves that id against the
// provider's variants. On-gateway the web derives the ids from the API's
// `reasoning_options` (packages/sdk provider-selection.ts, via
// @kortix/llm-catalog's generationControlCapabilities), so both harnesses must
// publish the SAME ids or a picked tier silently does nothing. Mirror of that
// derivation (this package cannot import @kortix/llm-catalog): an `effort`
// knob → its values verbatim; a `budget_tokens` knob → the low/medium/high
// tiers the gateway's Claude mapping accepts; anything else → no variants.
// Each variant carries `reasoningEffort`, which `@ai-sdk/openai-compatible`
// serializes as the `reasoning_effort` the gateway reads.
const BUDGET_TOKENS_EFFORT_TIERS = ['low', 'medium', 'high'] as const

export function variantsFromReasoningOptions(
  model: Pick<KortixGatewayModel, 'reasoning_options'>,
): Record<string, Record<string, unknown>> | undefined {
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : []
  const effort = options.find((o) => o && o.type === 'effort')
  const ids: string[] = effort?.values?.length
    ? effort.values.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : options.some((o) => o && o.type === 'budget_tokens')
      ? [...BUDGET_TOKENS_EFFORT_TIERS]
      : []
  if (ids.length === 0) return undefined
  return Object.fromEntries(ids.map((id) => [id, { reasoningEffort: id }]))
}
