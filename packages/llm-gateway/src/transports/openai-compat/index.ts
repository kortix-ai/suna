import type { UpstreamDescriptor } from '../../domain';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

function trimTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}

const GENUINE_OPENAI_HOSTNAME = 'api.openai.com';

// True only for the real OpenAI API host, never for an OpenAI-COMPATIBLE
// upstream (OpenRouter, Groq, self-hosted vLLM/LiteLLM/Ollama, "custom", etc.)
// even though those share `kind: 'openai-compat'` and flow through this same
// transport. Checked on the resolved base URL rather than `descriptor.provider`
// so it stays correct even if a future catalog entry mislabels the provider id.
// Exported: also used by ../route-kind.ts to decide whether a reasoning-model
// request with function tools must be routed to the openai-responses transport
// instead (chat/completions rejects that combination — see route-kind.ts).
export function isGenuineOpenAiUpstream(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === GENUINE_OPENAI_HOSTNAME;
  } catch {
    return false;
  }
}

// Whether this descriptor's model is a genuine OpenAI-family model that
// speaks OpenAI's own chat/completions param quirks (rejects `max_tokens` /
// non-default temperature-and-friends) — REGARDLESS of which literal host
// ends up serving the request.
//
// P0 incident (req_mro97uigg6rnflvf, 2026-07-17): a real `openai/gpt-5.6-sol`
// BYOK session 400ed with "Unsupported parameter: 'max_tokens' ... Use
// 'max_completion_tokens' instead" even though `resolveCandidates` built a
// descriptor whose `baseUrl` genuinely WAS `https://api.openai.com/v1` —
// proving `isGenuineOpenAiUpstream(baseUrl)` alone is too fragile a gate to
// hang correctness on for every future routing shape: an operator-configured
// proxy in front of OpenAI, a managed/Azure-fronted route, or any other
// OpenAI-compatible host that still speaks OpenAI's literal chat/completions
// wire format would all resolve a `baseUrl` that ISN'T `api.openai.com` while
// still needing this exact translation. The durable signal is the MODEL/
// CONNECTION identity, not the resolved network address: `descriptor.
// provider === 'openai'` is set once, in resolveCandidates.ts, directly from
// the caller's requested `openai/<model>` id — it doesn't move around based
// on which host that provider happens to resolve to. `isGenuineOpenAiUpstream`
// is kept as an OR-fallback (not replaced) so a `custom`/differently-labeled
// descriptor that genuinely resolves to api.openai.com is still covered —
// this is a strict widening, never a narrowing, of the original scope.
export function requiresOpenAiChatCompletionsQuirks(descriptor: {
  provider: string;
  baseUrl: string;
}): boolean {
  return descriptor.provider === 'openai' || isGenuineOpenAiUpstream(descriptor.baseUrl);
}

// OpenAI's chat completions endpoint now rejects `max_tokens` for its current
// chat models (o-series, gpt-5.x, and newer gpt-4o snapshots all 400 with
// "Unsupported parameter: 'max_tokens' is not supported with this model. Use
// 'max_completion_tokens' instead.") — observed live against api.openai.com.
// `max_completion_tokens` is accepted for every model OpenAI still serves
// under chat/completions, so the translation is unconditional for genuine
// OpenAI traffic (see `requiresOpenAiChatCompletionsQuirks` above) rather than
// a model-name allowlist that would need upkeep as OpenAI ships new model
// families. If the caller already sent `max_completion_tokens` (e.g.
// opencode/the SDK already speaks the new field), it passes through untouched
// and `max_tokens` is left alone too.
function translateMaxTokensForGenuineOpenAi(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!('max_tokens' in payload) || 'max_completion_tokens' in payload) return payload;
  const { max_tokens, ...rest } = payload;
  return { ...rest, max_completion_tokens: max_tokens };
}

// OpenAI's chat/completions endpoint rejects several more sampling params
// outright for the same reasoning-restricted models the max_tokens
// translation above targets (o-series, gpt-5.x): temperature/top_p only
// accept the default value ("Unsupported value: temperature does not support
// ... only the default (1) value"), and logprobs/penalties/logit_bias 400
// entirely. Gated on `descriptor.temperature === false` — the SAME capability
// flag the client-facing model picker already uses to grey out the
// temperature control (mirrored from models.dev via
// apps/api/.../catalog-models.ts capabilitiesForModel) — rather than a
// hardcoded model-id list, so it tracks the catalog without needing upkeep as
// OpenAI ships new reasoning-model families.
const REASONING_RESTRICTED_SAMPLING_PARAMS = [
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'logprobs',
  'top_logprobs',
  'logit_bias',
] as const;

function stripReasoningRestrictedSamplingParams(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!REASONING_RESTRICTED_SAMPLING_PARAMS.some((key) => key in payload)) return payload;
  const next = { ...payload };
  for (const key of REASONING_RESTRICTED_SAMPLING_PARAMS) delete next[key];
  return next;
}

// Perplexity's Sonar chat/completions endpoint enforces strict role
// alternation after any leading system message(s): two consecutive
// user/assistant/tool turns 400 with "messages should alternate". Normal
// opencode tool-calling sessions routinely produce back-to-back same-role
// turns (e.g. a `tool` result immediately followed by another `user` message,
// or two consecutive `tool` results), so — scoped to Perplexity only — merge
// consecutive same-effective-role messages instead of forwarding the raw
// array untouched. `tool` has no Perplexity-native equivalent, so it's folded
// into the surrounding `user` turn for alternation purposes.
function effectiveRole(role: unknown): unknown {
  return role === 'tool' ? 'user' : role;
}

function contentToParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
  return [];
}

function mergeContent(a: unknown, b: unknown): unknown {
  if (typeof a === 'string' && typeof b === 'string') return [a, b].filter(Boolean).join('\n\n');
  return [...contentToParts(a), ...contentToParts(b)];
}

function mergeSameRoleMessages(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...a, content: mergeContent(a.content, b.content) };
  const toolCallsA = Array.isArray(a.tool_calls) ? (a.tool_calls as unknown[]) : undefined;
  const toolCallsB = Array.isArray(b.tool_calls) ? (b.tool_calls as unknown[]) : undefined;
  if (toolCallsA || toolCallsB) merged.tool_calls = [...(toolCallsA ?? []), ...(toolCallsB ?? [])];
  return merged;
}

function normalizeRoleSequenceForPerplexity(messages: unknown[]): unknown[] {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') {
      out.push(raw as Record<string, unknown>);
      continue;
    }
    const message = raw as Record<string, unknown>;
    // System messages don't participate in the alternation requirement and
    // may repeat/lead freely — never merged into or with anything.
    if (message.role === 'system') {
      out.push(message);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role !== 'system' &&
      effectiveRole(prev.role) === effectiveRole(message.role)
    ) {
      out[out.length - 1] = mergeSameRoleMessages(prev, message);
      continue;
    }
    out.push(message);
  }
  return out;
}

// OpenAI's real streaming Chat Completions API only emits a `usage` object on
// a trailing chunk when the request sets `stream_options: {include_usage:
// true}` — without it, no chunk ever carries usage, and the whole completion
// bills at $0 (extractUsageFromSseBuffer finds nothing to extract). The
// handler already force-injects this for every streaming request generically
// (pipeline/handler.ts, before any transport sees the body), but that's a
// second, upstream layer this transport doesn't control — so genuine OpenAI
// traffic gets its own belt-and-suspenders injection here too, exactly like
// the max_tokens translation above, so a future refactor of the handler's
// payload construction can't silently reopen the $0-billing gap for OpenAI
// specifically. A caller that already set stream_options is never overridden.
function ensureStreamUsageForGenuineOpenAi(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.stream !== true) return payload;
  const existing = payload.stream_options;
  if (existing && typeof existing === 'object') {
    if ((existing as { include_usage?: unknown }).include_usage === undefined) {
      return { ...payload, stream_options: { ...existing, include_usage: true } };
    }
    return payload;
  }
  return { ...payload, stream_options: { include_usage: true } };
}

export function buildUpstreamRequest(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
): UpstreamRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (!descriptor.omitAuthorization) headers.authorization = `Bearer ${descriptor.apiKey}`;
  if (descriptor.appName) headers['x-title'] = descriptor.appName;
  if (descriptor.appReferer) headers['http-referer'] = descriptor.appReferer;
  if (descriptor.headers) Object.assign(headers, descriptor.headers);

  let payload = body;
  if (descriptor.bodyExtras) payload = { ...payload, ...descriptor.bodyExtras };
  if (descriptor.resolvedModel) payload = { ...payload, model: descriptor.resolvedModel };
  // Model-identity-scoped quirks (max_tokens rename, reasoning-restricted
  // sampling params) — fire for ANY descriptor whose model is genuinely
  // OpenAI's, regardless of which host it resolves to. See
  // `requiresOpenAiChatCompletionsQuirks`'s doc comment for the incident this
  // widening fixes.
  if (requiresOpenAiChatCompletionsQuirks(descriptor)) {
    payload = translateMaxTokensForGenuineOpenAi(payload);
    if (descriptor.temperature === false) {
      payload = stripReasoningRestrictedSamplingParams(payload);
    }
  }
  // Billing-safety quirk (force stream usage accounting) stays scoped to the
  // LITERAL genuine host — it exists to stop $0-billing against Kortix's own
  // real upstream fetch to api.openai.com, not a model-identity concern, so
  // widening it the same way as the params above isn't warranted.
  if (isGenuineOpenAiUpstream(descriptor.baseUrl)) {
    payload = ensureStreamUsageForGenuineOpenAi(payload);
  }
  if (descriptor.provider === 'perplexity' && Array.isArray(payload.messages)) {
    payload = {
      ...payload,
      messages: normalizeRoleSequenceForPerplexity(payload.messages as unknown[]),
    };
  }

  return {
    url: `${trimTrailingSlash(descriptor.baseUrl)}/chat/completions`,
    headers,
    payload,
  };
}
