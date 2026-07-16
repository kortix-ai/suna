import type { ProviderKind, UpstreamDescriptor } from '../domain';
import { isGenuineOpenAiUpstream } from './openai-compat';

type Json = Record<string, unknown>;

function hasFunctionTools(body: Json): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

// The effective reasoning effort the client asked for, whichever shape it was
// sent in — the OpenAI chat/completions field (`reasoning_effort: string`) or
// the Responses-style nested object (`reasoning: { effort: string }`), which
// opencode/callers occasionally send directly. Mirrors
// openai-responses/request.ts's `reasoningFromBody`.
function reasoningEffort(body: Json): string | undefined {
  if (typeof body.reasoning_effort === 'string') return body.reasoning_effort;
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object') {
    const effort = (reasoning as Json).effort;
    if (typeof effort === 'string') return effort;
  }
  return undefined;
}

/**
 * OpenAI's /v1/chat/completions rejects genuine reasoning-family models
 * (o-series, gpt-5.x) whenever BOTH function tools and a non-'none' reasoning
 * effort are present on the request:
 *
 *   "Function tools with reasoning_effort are not supported for gpt-5.5 in
 *   /v1/chat/completions. To use function tools, use /v1/responses or set
 *   reasoning_effort to 'none'."
 *
 * (observed live against api.openai.com — BYOK gpt-5.5/gpt-5.6 agent sessions
 * on essentia.kortix.cloud, session 21c6cfd0-5157-4e78-9d26-4198656b1a81).
 *
 * The openai-responses transport (./openai-responses) already speaks the
 * Responses API end to end (messages→input, tools, tool_choice,
 * reasoning_effort, streaming + non-streaming translation back to the
 * OpenAI-chat wire shape) — it was wired ONLY to the ChatGPT/Codex OAuth path
 * (`descriptor.provider === 'openai-codex'`, chosen directly in
 * apps/api/.../descriptors.ts codexDescriptor), but none of its request/
 * response translation actually depends on that credential type. Reused here
 * verbatim for genuine BYOK/managed OpenAI traffic rather than standing up a
 * second translator, or (the smaller-looking but wrong fix) forcing
 * `reasoning_effort` to 'none' and silently degrading reasoning quality for
 * every tool-using request.
 *
 * Gated narrowly so this only ever affects the exact broken combination:
 *  - `descriptor.kind === 'openai-compat'` — never touches anthropic/bedrock/
 *    custom, and never an already-'openai-responses' descriptor (Codex
 *    chooses its own transport independently in descriptors.ts).
 *  - `descriptor.reasoning === true` — the SAME models.dev-derived capability
 *    flag #4814 uses to strip reasoning-restricted sampling params, so a
 *    non-reasoning OpenAI model (gpt-4o, gpt-4.1, ...) is never routed here.
 *  - `isGenuineOpenAiUpstream(descriptor.baseUrl)` — never for an OpenAI-
 *    compatible-but-not-genuine-OpenAI upstream (OpenRouter, Groq, Azure
 *    OpenAI, self-hosted vLLM/LiteLLM/Ollama), whose `/responses` surface (if
 *    it even has one) isn't this same wire contract.
 *  - the request actually hits the failing shape: function tools present AND
 *    reasoning_effort isn't explicitly 'none' (OpenAI's own error message
 *    says 'none' keeps chat/completions working) — so a plain reasoning-model
 *    turn with no tools, which already works fine today on chat/completions,
 *    is left completely alone, minimizing blast radius to exactly the broken
 *    combination instead of moving every reasoning-model request onto a
 *    different wire format (Responses doesn't translate every chat/completions
 *    field this codebase supports, e.g. response_format/json_schema — no
 *    reason to risk those paths when they aren't the ones that are broken).
 *
 * Called per-attempt from `callUpstream` (body is available there; descriptor
 * resolution in apps/api's resolveCandidates happens before the body's
 * tools/reasoning_effort are known to that layer) — cheap enough to run on
 * every dispatch, including each failover retry.
 */
export function resolveTransportKind(body: Json, descriptor: UpstreamDescriptor): ProviderKind {
  if (
    descriptor.kind === 'openai-compat' &&
    descriptor.reasoning === true &&
    isGenuineOpenAiUpstream(descriptor.baseUrl) &&
    hasFunctionTools(body) &&
    reasoningEffort(body) !== 'none'
  ) {
    return 'openai-responses';
  }
  return descriptor.kind;
}
