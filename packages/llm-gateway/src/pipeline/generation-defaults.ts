import type { ModelGenerationDefaults } from '../domain';
import { reasoningEffort as explicitReasoningEffort } from '../transports/route-kind';

/**
 * Merge a route's configured generation-parameter defaults into an inbound
 * OpenAI chat/completions body — but ONLY for a field the client did not
 * already set. Explicit client values always win; this never overwrites one.
 *
 * Mutates nothing: returns a new object (or the same reference when there is
 * nothing to inject) so callers can `payload = applyGenerationDefaults(...)`
 * the same way `handleChatCompletions` already treats `body`/`payload` as
 * copy-on-write.
 *
 * This is the ONE function that merges these defaults into the wire body —
 * every client (opencode sessions, the SDK, direct /v1/chat/completions and,
 * via the Anthropic-messages ingress's shared pipeline, /v1/messages) gets
 * them this same way. But it is called MORE THAN ONCE per turn: `handler.ts`
 * does NOT bake defaults into the body up front — `runFailover` (failover.ts)
 * calls this fresh for EACH candidate it dispatches to, via
 * `ModelRoutePlan.generationDefaultsForModel`, so a turn that fails over
 * from the primary model to a fallback with different capabilities gets the
 * FALLBACK's own defaults, not the primary's stale ones. `buildAiSdkArgs`
 * (transports/ai-sdk/request.ts) already reads every one of these fields
 * straight off the body — this function's whole job is getting a value INTO
 * the body, never re-deriving how a transport consumes it.
 *
 * Capability gating and value clamping (never inject `temperature` into a
 * temperature:false model, always clamp `reasoning_effort` to the model's
 * own `reasoning_options` values, always clamp `max_output_tokens` to
 * `limit.output`) happen BEFORE this, PER CANDIDATE — see
 * `@kortix/llm-catalog`'s `clampGenerationConfig`, run by the host each time
 * it builds a candidate's defaults (apps/api's routing/resolve-route.ts's
 * `generationDefaultsFor`, invoked once per failover candidate via
 * `generationDefaultsForModel`). This function trusts its input.
 */
export function applyGenerationDefaults(
  body: Record<string, unknown>,
  defaults: ModelGenerationDefaults | undefined,
): Record<string, unknown> {
  if (!defaults) return body;

  const patch: Record<string, unknown> = {};

  if (typeof defaults.reasoningEffort === 'string' && explicitReasoningEffort(body) === undefined) {
    patch.reasoning_effort = defaults.reasoningEffort;
  }
  if (typeof defaults.temperature === 'number' && typeof body.temperature !== 'number') {
    patch.temperature = defaults.temperature;
  }
  if (typeof defaults.topP === 'number' && typeof body.top_p !== 'number') {
    patch.top_p = defaults.topP;
  }
  if (
    typeof defaults.maxOutputTokens === 'number' &&
    typeof body.max_tokens !== 'number' &&
    typeof body.max_completion_tokens !== 'number'
  ) {
    patch.max_tokens = defaults.maxOutputTokens;
  }

  return Object.keys(patch).length ? { ...body, ...patch } : body;
}
