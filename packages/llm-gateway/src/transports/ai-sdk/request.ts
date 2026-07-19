import type { BedrockProviderOptions } from '@ai-sdk/amazon-bedrock';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import type { OpenAIChatLanguageModelOptions } from '@ai-sdk/openai';
import {
  type JSONValue,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
  jsonSchema,
  tool,
} from 'ai';
import { reasoningEffort as reasoningEffortFromBody } from '../route-kind';
import type { AiSdkFamily } from './model';

// `system` normally collapses to a plain string, but the anthropic/bedrock
// prompt-caching port below (applyAnthropicPromptCaching) needs to attach a
// `providerOptions` cache breakpoint to the system prompt itself — the only
// way to do that is to hand `streamText`/`generateText` a `SystemModelMessage`
// object instead of a bare string (see "ai"'s `Instructions` type: `string |
// SystemModelMessage | Array<SystemModelMessage>` — confirmed in
// node_modules/ai/dist/index.d.ts).
export type AiSdkSystemInstruction = {
  role: 'system';
  content: string;
  providerOptions?: Record<string, Record<string, JSONValue>>;
};

// Everything the AI-SDK engine needs to drive `streamText`/`generateText`,
// derived once from the incoming OpenAI chat.completions body. The AI SDK owns
// per-provider quirks from here on (endpoint, param names, tool translation).
export interface AiSdkCallArgs {
  system?: string | AiSdkSystemInstruction;
  messages: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
  // Drives structured-output (response_format) — see buildResponseFormatOutput
  // below. `undefined` means "plain text", matching streamText/generateText's
  // own default when no `output` is passed.
  output?: AiSdkOutput;
}

function safeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
  }
  return '';
}

type UserContentPart = { type: 'text'; text: string } | { type: 'image'; image: URL | string };

function translateUserContent(content: unknown): string | UserContentPart[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOf(content);
  const parts: UserContentPart[] = [];
  for (const raw of content) {
    const part = raw as { type?: string; text?: string; image_url?: { url?: string } };
    if (part?.type === 'text') parts.push({ type: 'text', text: String(part.text ?? '') });
    else if (part?.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url;
      parts.push({ type: 'image', image: url });
    }
  }
  return parts.length ? parts : textOf(content);
}

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

// OpenAI chat.completions messages → AI SDK ModelMessage[]. System messages are
// hoisted into `system` (kept separate so provider prompt-caching works). The
// role/tool-call/tool-result shape mirrors what the native transports build, but
// in the neutral AI-SDK core format the provider package then re-serializes.
export function toModelMessages(rawMessages: unknown): {
  system?: string;
  messages: ModelMessage[];
} {
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  const systemParts: string[] = [];
  const out: ModelMessage[] = [];

  for (const raw of messages) {
    const m = raw as {
      role?: string;
      content?: unknown;
      tool_calls?: OpenAiToolCall[];
      tool_call_id?: string;
      name?: string;
    };
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.tool_call_id ?? '',
            toolName: m.name ?? '',
            output: {
              type: 'text',
              value: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
            },
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = [];
      const text = textOf(m.content);
      if (text) parts.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id ?? '',
          toolName: tc.function?.name ?? '',
          input: safeParseJson(tc.function?.arguments),
        });
      }
      out.push({
        role: 'assistant',
        content: parts.length ? parts : text,
      });
      continue;
    }
    out.push({ role: 'user', content: translateUserContent(m.content) });
  }

  return {
    system: systemParts.filter(Boolean).join('\n\n') || undefined,
    messages: out,
  };
}

// OpenAI `tools` → an AI SDK ToolSet with NO `execute`. Without an executor the
// SDK surfaces the model's tool call in the stream and stops the step (it never
// tries to run the tool), which is exactly the relay-to-client behaviour the
// gateway needs — opencode executes tools, not us.
function toToolSet(rawTools: unknown): ToolSet | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const raw of rawTools) {
    const fn = (raw as { function?: { name?: string; description?: string; parameters?: unknown } })
      .function;
    if (!fn?.name) continue;
    set[fn.name] = tool({
      description: fn.description,
      inputSchema: jsonSchema((fn.parameters as object) ?? { type: 'object', properties: {} }),
    });
  }
  return Object.keys(set).length ? set : undefined;
}

function toToolChoice(raw: unknown): ToolChoice<ToolSet> | undefined {
  if (raw === 'required') return 'required';
  if (raw === 'auto') return 'auto';
  if (raw === 'none') return 'none';
  if (raw && typeof raw === 'object') {
    const name = (raw as { function?: { name?: string } }).function?.name;
    if (name) return { type: 'tool', toolName: name };
  }
  return undefined;
}

// OpenAI wire fields that carry no AI-SDK top-level CallSettings equivalent
// (unlike temperature/topP/stopSequences/seed/frequencyPenalty/
// presencePenalty, which the SDK core exposes directly — see the seed/
// penalty mapping in buildAiSdkArgs below) but that native's openai-compat
// forwards completely verbatim to the upstream (openai-compat/index.ts:
// `payload = body`, untouched unless one of its few named rewrites fires).
// Threaded through providerOptions instead of CallSettings:
//  - 'openai' family: @ai-sdk/openai's own schema
//    (openaiLanguageModelChatOptions) recognizes each of these under
//    providerOptions.openai by CAMELCASE name and re-serializes them back to
//    the identical wire field (see its chat getArgs `baseArgs`).
//  - 'openai-compatible' family: its schema only recognizes
//    user/reasoningEffort/textVerbosity/strictJsonSchema — any OTHER key
//    under providerOptions[<provider name>] rides straight onto the wire
//    request UNMODIFIED (getArgs spreads everything not in its own schema's
//    `.shape` verbatim) — so these are set using the RAW WIRE (snake_case)
//    field names here, not the openai package's camelCase ones, since no
//    schema ever translates them for this family.
// Deliberately NOT mapped: `n` (multiple choices) — even forwarded onto the
// wire, this transport only ever reconstructs ONE choice from AI-SDK's
// single-result `streamText`/`generateText` (see sse.ts/index.ts), so
// setting n>1 would silently bill for completions the client never receives
// instead of doing nothing; and `modalities` (audio output) — no current
// caller (opencode/agents) requests non-text output and AI SDK core has no
// hook for it on streamText/generateText.
function extraOpenAiFields(
  body: Record<string, unknown>,
  family: 'openai' | 'openai-compatible',
): Record<string, unknown> {
  const logitBias = body.logit_bias;
  const logprobs = body.logprobs;
  const topLogprobs = body.top_logprobs;
  const parallelToolCalls = body.parallel_tool_calls;
  const user = body.user;
  const serviceTier = body.service_tier;
  const metadata = body.metadata;
  const prediction = body.prediction;

  if (family === 'openai') {
    return {
      logitBias: logitBias && typeof logitBias === 'object' ? logitBias : undefined,
      // @ai-sdk/openai encodes "how many top logprobs" as the VALUE of a
      // single `logprobs` option (boolean → just the chosen token; number →
      // that many alternatives) — collapse OpenAI's two wire fields
      // (`logprobs: boolean`, `top_logprobs: number`) into it.
      logprobs:
        typeof topLogprobs === 'number'
          ? topLogprobs
          : typeof logprobs === 'boolean'
            ? logprobs
            : undefined,
      parallelToolCalls: typeof parallelToolCalls === 'boolean' ? parallelToolCalls : undefined,
      user: typeof user === 'string' ? user : undefined,
      serviceTier: typeof serviceTier === 'string' ? serviceTier : undefined,
      metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
      prediction: prediction && typeof prediction === 'object' ? prediction : undefined,
    };
  }

  return {
    logit_bias: logitBias && typeof logitBias === 'object' ? logitBias : undefined,
    logprobs: typeof logprobs === 'boolean' ? logprobs : undefined,
    top_logprobs: typeof topLogprobs === 'number' ? topLogprobs : undefined,
    parallel_tool_calls: typeof parallelToolCalls === 'boolean' ? parallelToolCalls : undefined,
    user: typeof user === 'string' ? user : undefined,
    service_tier: typeof serviceTier === 'string' ? serviceTier : undefined,
    metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
    prediction: prediction && typeof prediction === 'object' ? prediction : undefined,
  };
}

type AiSdkResponseFormat =
  | { type: 'text' }
  | { type: 'json'; schema?: unknown; name?: string; description?: string };

// A hand-built AI-SDK `Output` (see ai's `Output.text()`/`Output.object()`)
// carrying an EXACT wire-level responseFormat, instead of the one those two
// factories produce. Needed because:
//  - `Output.text()` always resolves `{type:'text'}` — no way to request JSON.
//  - `Output.object()` ALWAYS attaches a schema (a required param), so it can
//    only ever produce OpenAI's 'json_schema' wire variant — never plain
//    'json_object' (no schema). OpenAI's `response_format:{type:'json_object'}`
//    is a real, commonly used, DIFFERENT mode (looser, no Structured-Outputs
//    validation) from 'json_schema'; forcing every such request through
//    Output.object with a dummy/empty schema would silently switch modes,
//    which is not the parity fix this is meant to be — see
//    responseFormatFromBody below, which preserves the client's exact choice
//    of mode by only ever attaching a schema when the client's own
//    response_format was `json_schema`.
// Confirmed by reading ai's source (ai/dist/index.js): streamText/generateText
// await ONLY `output.responseFormat` before calling doGenerate/doStream —
// `parseCompleteOutput`/`parsePartialOutput`/`createElementStreamTransform`
// feed `result.experimental_output`, which this transport never reads (it
// always reads `.text`/`.reasoningText` and forwards those as the OpenAI
// `message.content` string — see index.ts/sse.ts), so those three are inert
// stubs here, not a functional gap.
function buildResponseFormatOutput(responseFormat: AiSdkResponseFormat) {
  return {
    name: 'response_format',
    // `schema`, when present, is the client's own already-supplied JSON
    // Schema object, forwarded verbatim — exactly what native does. Typed
    // `unknown` here (rather than importing @ai-sdk/provider's JSONSchema7
    // just for this cast) keeps this module decoupled from that package's
    // exact type surface; the AI SDK only ever JSON-serializes this value
    // onto the wire, it never validates its TS shape at runtime.
    // biome-ignore lint: cast crosses into @ai-sdk/provider's JSONSchema7
    // type, which this module deliberately doesn't import (see comment
    // above) — the AI SDK only ever JSON-serializes this value onto the
    // wire, it never validates it against that type at runtime.
    responseFormat: Promise.resolve(responseFormat) as any,
    async parseCompleteOutput({ text }: { text: string }): Promise<string> {
      return text;
    },
    async parsePartialOutput({ text }: { text: string }): Promise<{ partial: string } | undefined> {
      return { partial: text };
    },
    createElementStreamTransform(): undefined {
      return undefined;
    },
  };
}

export type AiSdkOutput = ReturnType<typeof buildResponseFormatOutput>;

interface OpenAiResponseFormatBody {
  type?: string;
  json_schema?: { schema?: unknown; name?: string; description?: string; strict?: boolean };
}

// CONFIRMED DEFECT fix (2026-07-17, live-observed): buildAiSdkArgs never
// read `body.response_format` at all — JSON mode / structured output was
// silently dropped on the ai-sdk engine (plain prose back instead of JSON),
// a parity regression vs native (openai-compat forwards the whole body,
// response_format included, verbatim). Reduces both OpenAI response_format
// wire variants down to what buildResponseFormatOutput needs: `json_object`
// (no schema) and `json_schema` (schema attached) both map onto AI SDK's
// `{type:'json', schema?}`* — schema presence/absence is what tells the
// downstream provider package which of the two to actually emit back onto
// the wire (see @ai-sdk/openai's and @ai-sdk/openai-compatible's chat
// getArgs: `schema != null ? {type:'json_schema',...} : {type:'json_object'}`).
function responseFormatFromBody(body: Record<string, unknown>): AiSdkResponseFormat | undefined {
  const raw = body.response_format as OpenAiResponseFormatBody | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.type === 'json_object') return { type: 'json' };
  if (raw.type === 'json_schema' && raw.json_schema) {
    return {
      type: 'json',
      schema: raw.json_schema.schema,
      name: raw.json_schema.name,
      description: raw.json_schema.description,
    };
  }
  return undefined;
}

// Only the two families whose NATIVE transport is openai-compat (the
// verbatim body-forwarding path — see openai-compat/index.ts) ever actually
// deliver `response_format` to an upstream today: genuine OpenAI and any
// generic OpenAI-compatible upstream (OpenRouter, Groq, self-hosted...).
// anthropic/bedrock's native transports (anthropic/request.ts's
// buildAnthropicCorePayload, shared by bedrock) never read
// `body.response_format` at all — it's silently dropped there too — so NOT
// mapping it for those two families here is matching parity, not a gap. Lives
// on the adapter as `supportsResponseFormat` now (see ProviderAdapter below)
// instead of a standalone family Set.
function strictJsonSchemaField(raw: Record<string, unknown>): boolean | undefined {
  const responseFormat = responseFormatFromBody(raw);
  if (responseFormat?.type !== 'json' || responseFormat.schema === undefined) return undefined;
  // Both provider packages default `strictJsonSchema` to `true` (OpenAI
  // Structured Outputs' stricter validation) when the key is absent — but
  // native forwards the client's body verbatim, so an omitted `strict` field
  // reaches OpenAI as ITS OWN default (`false` for chat/completions'
  // json_schema mode), not the AI SDK's default. Only ever honor an EXPLICIT
  // `strict:true` from the client; never let the ai-sdk engine be stricter
  // than native would have been for the exact same request.
  const rawStrict = raw.response_format as OpenAiResponseFormatBody | undefined;
  return rawStrict?.json_schema?.strict === true;
}

// ---------------------------------------------------------------------------
// Anthropic / Bedrock extended-thinking + prompt-caching parity fix.
//
// The now-deleted native anthropic/bedrock transports (readable on origin/main
// via `git show origin/main:packages/llm-gateway/src/transports/anthropic/request.ts`
// and `.../bedrock/request.ts`) translated a client's `reasoning_effort` (or a
// raw Anthropic-shaped `body.thinking`) into Anthropic extended thinking,
// bumped `max_tokens` to fit the thinking budget, and applied prompt-cache
// breakpoints to the system prompt, the last tool definition, and the last
// message. None of that existed on the ai-sdk engine: an earlier version of
// this file merged `providerOptions.anthropic.reasoningEffort` for EVERY
// family including anthropic/bedrock — a field @ai-sdk/anthropic's zod schema
// (`AnthropicProviderOptions` in node_modules/@ai-sdk/anthropic/dist/index.d.ts)
// does not define, so it was silently stripped and thinking never actually
// turned on. Prompt caching had no equivalent at all. Ported below, with the
// exact field names verified against the installed package internals rather
// than assumed:
//
//  - @ai-sdk/anthropic (its exported `AnthropicProviderOptions` type,
//    `CacheControlValidator`/`getCacheControl` in dist/index.js): thinking is
//    `providerOptions.anthropic.thinking = {type:'adaptive'}` + a top-level
//    `providerOptions.anthropic.effort` tier (the package serializes `effort`
//    to the wire's `output_config.effort`) — current-gen Claude rejects the
//    legacy `{type:'enabled', budgetTokens}` shape (see applyAnthropicThinking);
//    caching is `providerOptions.anthropic.cacheControl = {type:'ephemeral'}`,
//    read PER message/part/tool, not once globally.
//  - @ai-sdk/amazon-bedrock (its exported `BedrockProviderOptions` type,
//    dist/index.js): thinking is
//    `providerOptions.bedrock.reasoningConfig = {type:'enabled', budgetTokens}`.
//    Caching is NOT `cacheControl` — model.ts's `resolveAiModel` builds the
//    bedrock family via `createAmazonBedrock(...)`, i.e. AWS's own Converse
//    API, not the Anthropic-shaped InvokeModel path native's bedrock
//    transport used — so its cache primitive is a separate `cachePoint`
//    content block: `providerOptions.bedrock.cachePoint = {type:'default'}`
//    (dist/index.js's `getCachePoint`/`pushCachePoint`) — a PER-MESSAGE/part
//    provider option, which is why it's not part of `BedrockProviderOptions`
//    (that type only covers the top-level generation options: reasoningConfig
//    etc.) and is built by hand in applyAnthropicPromptCaching below instead.
//    Bedrock's own `prepareTools` (the Converse `toolConfig` builder) never
//    reads a function tool's `providerOptions` at all, so there is no
//    per-tool cache breakpoint available on this SDK version for Bedrock —
//    only system + last-message caching apply there; last-tool caching is
//    anthropic-only.
const REASONING_EFFORT_BUDGET_TOKENS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16000,
  // Above 'high' but below 'max' — some newer Claude/Bedrock reasoning
  // models (see packages/llm-catalog's generated catalog reasoning_options,
  // e.g. claude-opus-4-8's `['low','medium','high','xhigh','max']`) expose a
  // fifth effort tier between the two. Without an entry here, selecting
  // 'xhigh' silently produced NO thinking budget at all (falls through every
  // check in resolveThinkingRequest/clampGenerationConfig's
  // reasoningEffort branch).
  xhigh: 24000,
  max: 32000,
};

// Mirrors native's DEFAULT_MAX_TOKENS_WITH_THINKING: both providers require
// budgetTokens to be strictly less than max output tokens, so a thinking
// request with no explicit max_tokens needs a much bigger default ceiling
// than the plain 4096 used for non-thinking anthropic/bedrock requests.
const DEFAULT_MAX_TOKENS_WITH_THINKING = 32_000;

// The effort tiers @ai-sdk/anthropic's `providerOptions.anthropic.effort` enum
// accepts (serialized to the wire's `output_config.effort`). Our internal
// reasoning tiers add 'minimal', which Anthropic has no equivalent for → fold
// it into the lowest real tier.
type AnthropicThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const ANTHROPIC_EFFORT_TIERS = new Set<AnthropicThinkingEffort>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
function toAnthropicEffort(tier: string | undefined): AnthropicThinkingEffort | undefined {
  if (!tier) return undefined;
  if (tier === 'minimal') return 'low';
  return ANTHROPIC_EFFORT_TIERS.has(tier as AnthropicThinkingEffort)
    ? (tier as AnthropicThinkingEffort)
    : undefined;
}
// Reverse the budget table so a raw `budget_tokens` request (no effort tier)
// still maps onto an adaptive-thinking effort tier — newer Claude models only
// accept adaptive thinking, so we can never fall back to a raw token budget.
function budgetToAnthropicEffort(budget: number): AnthropicThinkingEffort {
  if (budget <= REASONING_EFFORT_BUDGET_TOKENS.low) return 'low';
  if (budget <= REASONING_EFFORT_BUDGET_TOKENS.medium) return 'medium';
  if (budget <= REASONING_EFFORT_BUDGET_TOKENS.high) return 'high';
  if (budget <= REASONING_EFFORT_BUDGET_TOKENS.xhigh) return 'xhigh';
  return 'max';
}

interface ResolvedThinking {
  // Token budget — used by Bedrock's `reasoningConfig` and to size maxOutputTokens.
  budgetTokens: number;
  // Effort tier — used by Anthropic's ADAPTIVE thinking (see the call site).
  effort: AnthropicThinkingEffort;
}

// Client-supplied `reasoning_effort` (OpenAI/opencode-shaped), an OpenAI
// Responses-style `reasoning.effort`/`reasoning.budget_tokens`/`.max_tokens`,
// or a raw Anthropic-shaped `body.thinking:{type:'enabled',budget_tokens}`
// block — resolved into BOTH a thinking-token budget (for Bedrock + maxTokens
// sizing) AND an effort tier (for Anthropic adaptive thinking). Ported
// field-for-field (including the budget table) from the deleted native
// anthropic transport's `translateThinking` + `REASONING_EFFORT_BUDGET_TOKENS`.
// Like native: an explicit `body.thinking` object that ISN'T the
// `{type:'enabled', budget_tokens>0}` shape (e.g. `{type:'disabled'}`) returns
// "no thinking" WITHOUT falling through to the reasoning/effort checks below —
// an explicit disable must win.
function resolveThinkingRequest(
  body: Record<string, unknown>,
  reasoningEffort: string | undefined,
): ResolvedThinking | undefined {
  const rawThinking = body.thinking;
  if (rawThinking && typeof rawThinking === 'object') {
    const budget = (rawThinking as { budget_tokens?: unknown }).budget_tokens;
    const type = (rawThinking as { type?: unknown }).type;
    if (type === 'enabled' && typeof budget === 'number' && budget > 0) {
      return { budgetTokens: budget, effort: budgetToAnthropicEffort(budget) };
    }
    return undefined;
  }

  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object') {
    const explicit =
      (reasoning as { budget_tokens?: unknown }).budget_tokens ??
      (reasoning as { max_tokens?: unknown }).max_tokens;
    if (typeof explicit === 'number' && explicit > 0) {
      return { budgetTokens: explicit, effort: budgetToAnthropicEffort(explicit) };
    }
    const effort = (reasoning as { effort?: unknown }).effort;
    if (typeof effort === 'string' && REASONING_EFFORT_BUDGET_TOKENS[effort] != null) {
      return {
        budgetTokens: REASONING_EFFORT_BUDGET_TOKENS[effort],
        effort: toAnthropicEffort(effort) ?? 'medium',
      };
    }
  }

  if (
    typeof reasoningEffort === 'string' &&
    REASONING_EFFORT_BUDGET_TOKENS[reasoningEffort] != null
  ) {
    return {
      budgetTokens: REASONING_EFFORT_BUDGET_TOKENS[reasoningEffort],
      effort: toAnthropicEffort(reasoningEffort) ?? 'medium',
    };
  }

  return undefined;
}

// Extended thinking is the one place the two Claude backends genuinely diverge:
// they are DIFFERENT AI-SDK packages with DIFFERENT wire contracts. Direct
// Anthropic (@ai-sdk/anthropic) and AWS Bedrock (@ai-sdk/amazon-bedrock, the
// Converse API) each get their own builder below, keyed off
// `resolveThinkingRequest`'s single result — no shared "is it anthropic or
// bedrock" branch anywhere; each function below returns ONLY the fields its
// own family's adapter (see ADAPTERS below) merges into its typed options.

// @ai-sdk/anthropic — current-gen Claude (Opus 4.5+/4.8) REJECTS the legacy
// `thinking.type:"enabled"` + budget_tokens shape ("`thinking.type.enabled` is
// not supported for this model. Use `thinking.type.adaptive` and
// `output_config.effort`"). So we drive extended thinking through ADAPTIVE + an
// effort tier — the model manages its own budget, and @ai-sdk/anthropic
// serializes `effort` to the wire's `output_config.effort`. (No budgetTokens to
// clamp; the caller's maxOutputTokens bump gives thinking + answer headroom.)
// The old `enabled` shape broke every explicit-reasoning-effort turn on
// Anthropic; only AUTO worked because it sent no thinking block at all.
function applyAnthropicThinking(
  resolved: ResolvedThinking,
): Pick<AnthropicProviderOptions, 'thinking' | 'effort'> {
  return { thinking: { type: 'adaptive' }, effort: resolved.effort };
}

// @ai-sdk/amazon-bedrock — Bedrock's Converse API still uses the
// `reasoningConfig: {type:"enabled", budgetTokens}` shape (it has NOT adopted
// Anthropic's adaptive/output_config surface). Converse rejects
// budgetTokens >= max output tokens, so clamp below the answer headroom.
function applyBedrockThinking(
  resolved: ResolvedThinking,
  maxTokens: number,
): Pick<BedrockProviderOptions, 'reasoningConfig'> {
  const budgetTokens = Math.min(resolved.budgetTokens, Math.max(1024, maxTokens - 1024));
  return { reasoningConfig: { type: 'enabled', budgetTokens } };
}

const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' } as const;
const BEDROCK_CACHE_POINT = { type: 'default' } as const;

function withProviderOption(
  existing: Record<string, Record<string, JSONValue>> | undefined,
  key: string,
  fields: Record<string, JSONValue>,
): Record<string, Record<string, JSONValue>> {
  return { ...existing, [key]: { ...existing?.[key], ...fields } };
}

// Port of native's `applyPromptCaching`. Marks the system prompt, the last
// tool definition (anthropic only — see the file-level comment above), and
// the last message with a cache breakpoint. Native applied this
// unconditionally to every anthropic/bedrock request regardless of size —
// mirrored here the same way rather than gated on request size.
function applyAnthropicPromptCaching(
  system: string | AiSdkSystemInstruction | undefined,
  messages: ModelMessage[],
  tools: ToolSet | undefined,
  family: 'anthropic' | 'bedrock',
): { system: string | AiSdkSystemInstruction | undefined; tools: ToolSet | undefined } {
  const cacheFields: Record<string, JSONValue> =
    family === 'anthropic'
      ? { cacheControl: ANTHROPIC_CACHE_CONTROL }
      : { cachePoint: BEDROCK_CACHE_POINT };

  let nextSystem = system;
  if (typeof system === 'string' && system) {
    nextSystem = {
      role: 'system',
      content: system,
      providerOptions: withProviderOption(undefined, family, cacheFields),
    };
  } else if (system && typeof system === 'object') {
    nextSystem = {
      ...system,
      providerOptions: withProviderOption(system.providerOptions, family, cacheFields),
    };
  }

  let nextTools = tools;
  if (family === 'anthropic' && tools) {
    const names = Object.keys(tools);
    const lastName = names[names.length - 1];
    if (lastName) {
      const lastTool = tools[lastName];
      nextTools = {
        ...tools,
        [lastName]: {
          ...lastTool,
          providerOptions: withProviderOption(
            lastTool.providerOptions as Record<string, Record<string, JSONValue>> | undefined,
            family,
            cacheFields,
          ),
        },
      } as ToolSet;
    }
  }

  if (messages.length) {
    const lastIndex = messages.length - 1;
    const lastMessage = messages[lastIndex];
    messages[lastIndex] = {
      ...lastMessage,
      providerOptions: withProviderOption(
        lastMessage.providerOptions as Record<string, Record<string, JSONValue>> | undefined,
        family,
        cacheFields,
      ),
    } as ModelMessage;
  }

  return { system: nextSystem, tools: nextTools };
}

// ---------------------------------------------------------------------------
// Normalization: the incoming OpenAI chat.completions body, translated ONCE
// into the family-agnostic shape every adapter below reads from. Sampling
// params with a direct AI-SDK CallSettings equivalent (temperature/top_p/
// stop/seed/penalties) have no per-family behaviour at all, so they're read
// straight off `raw` in the orchestrator instead of being duplicated here.
interface NormalizedRequest {
  // The original parsed body — adapters read family-specific raw fields
  // (`thinking`, `reasoning`, `response_format`, the openai-only extra
  // fields) directly off this rather than the orchestrator pre-extracting
  // every possible field a family might want.
  raw: Record<string, unknown>;
  system: string | AiSdkSystemInstruction | undefined;
  messages: ModelMessage[];
  tools: ToolSet | undefined;
  toolChoice: ToolChoice<ToolSet> | undefined;
  // Accepts both the chat/completions field (`reasoning_effort: string`) and
  // the Responses-style nested shape (`reasoning: { effort: string }`) some
  // callers (opencode) send directly, folded with the caller's own default
  // (Codex always sends a reasoning effort — see buildAiSdkArgs's opts doc).
  reasoningEffort: string | undefined;
  // `max_tokens` / `max_completion_tokens`, whichever is present — always
  // wins over any family default (see each adapter's `defaultMaxTokens`).
  explicitMaxTokens: number | undefined;
}

function normalizeRequest(
  body: Record<string, unknown>,
  opts: { defaultReasoningEffort?: string },
): NormalizedRequest {
  const { system, messages } = toModelMessages(body.messages);
  const tools = toToolSet(body.tools);
  const toolChoice = tools ? toToolChoice(body.tool_choice) : undefined;
  const reasoningEffort = reasoningEffortFromBody(body) ?? opts.defaultReasoningEffort;
  const explicitMaxTokens =
    (typeof body.max_tokens === 'number' ? body.max_tokens : undefined) ??
    (typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined);

  return { raw: body, system, messages, tools, toolChoice, reasoningEffort, explicitMaxTokens };
}

// ---------------------------------------------------------------------------
// Per-provider adapter registry.
//
// Each AI-SDK family (see model.ts's `AiSdkFamily`) has its own wire
// contract — a different `providerOptions` key, a different reasoning
// mechanism, different defaults, different caching primitives, and only two
// of the four ever see `response_format`. Before this refactor all of that
// lived as `if (family === ...)` branches sprinkled through one function
// (see git history) — easy to update one branch and forget a sibling (that's
// exactly how the openai-compatible reasoningEffort key and the Anthropic
// legacy-thinking-shape defects both happened). Now each family owns ONE
// adapter implementing this interface, keyed off `AiSdkFamily` in `ADAPTERS`
// below; `buildAiSdkArgs` is a thin orchestrator that never branches on
// family itself — it only ever asks "the adapter for this family" to do the
// family-specific work.
//
// `buildProviderOptions`'s return type is intentionally `Record<string,
// unknown>` at the interface level (the four families have four genuinely
// different shapes, and TypeScript has no clean way to key an interface
// method's return type off which family implements it) — but every
// individual adapter below builds and returns a value first typed against
// its OWN package's exported provider-options type
// (`AnthropicProviderOptions`, `BedrockProviderOptions`,
// `OpenAIChatLanguageModelOptions`), so assigning a field the SDK doesn't
// recognize, or misspelling one, is a compile error at the point it's
// constructed — precisely the class of defect (`thinking.type:'enabled'` vs
// `'adaptive'`, `providerOptions.openai` vs the real per-provider key) that
// motivated this refactor. openai-compatible is the one deliberate
// exception: `createOpenAICompatible`'s schema only recognizes
// user/reasoningEffort/textVerbosity/strictJsonSchema and forwards every
// OTHER key onto the wire completely unvalidated (see extraOpenAiFields'
// doc comment), so a loose `Record<string, unknown>` is the accurate type
// for that family, not a narrower one that would falsely imply validation
// exists.
interface ProviderAdapter {
  // Which `providerOptions` key this family's AI-SDK provider PACKAGE itself
  // reads back out — NOT an arbitrary label. Getting this wrong means the
  // options object is built but never consumed (silently inert). Only the
  // 'openai-compatible' adapter needs `providerName` (createOpenAICompatible's
  // chat model reads `providerOptions[<the exact `name` passed to it>]` — its
  // `providerOptionsName` getter, see @ai-sdk/openai-compatible's
  // chat-language-model.js — i.e. `descriptor.provider`, e.g. 'openrouter',
  // never the literal string 'openai'); every other family ignores it.
  optionsKey(providerName?: string): string;
  // Reasoning/thinking + family-specific extra fields + strictJsonSchema,
  // typed against this family's own SDK option type (see the interface doc
  // comment above). Returned fields with value `undefined` are dropped by
  // the orchestrator before being attached — an adapter never needs to omit
  // a key itself just to avoid sending it.
  buildProviderOptions(req: NormalizedRequest, providerName?: string): Record<string, unknown>;
  // maxOutputTokens to use when the client sent no explicit max_tokens/
  // max_completion_tokens. `undefined` (openai/openai-compatible) means
  // "let the AI SDK / upstream default apply" — unlike anthropic/bedrock,
  // neither family required an explicit ceiling before this transport
  // existed.
  defaultMaxTokens(req: NormalizedRequest): number | undefined;
  // Whether this family's native transport ever forwarded `response_format`
  // to the upstream (see the parity note above `strictJsonSchemaField`) —
  // gates whether the orchestrator builds an `AiSdkOutput` at all.
  supportsResponseFormat: boolean;
  // Prompt-cache breakpoint insertion (anthropic/bedrock only). Absent on
  // families with no caching primitive here (openai/openai-compatible).
  applyCaching?(
    system: string | AiSdkSystemInstruction | undefined,
    messages: ModelMessage[],
    tools: ToolSet | undefined,
  ): { system: string | AiSdkSystemInstruction | undefined; tools: ToolSet | undefined };
}

const openAiAdapter: ProviderAdapter = {
  optionsKey: () => 'openai',
  buildProviderOptions(req) {
    const options: OpenAIChatLanguageModelOptions = {};
    // The AI SDK's OpenAI provider strips temperature and other unsupported
    // params for reasoning models on its own — we only forward the effort.
    if (typeof req.reasoningEffort === 'string') {
      options.reasoningEffort =
        req.reasoningEffort as OpenAIChatLanguageModelOptions['reasoningEffort'];
    }
    Object.assign(options, extraOpenAiFields(req.raw, 'openai'));
    const strict = strictJsonSchemaField(req.raw);
    if (strict !== undefined) options.strictJsonSchema = strict;
    return options;
  },
  defaultMaxTokens: () => undefined,
  supportsResponseFormat: true,
};

const openAiCompatibleAdapter: ProviderAdapter = {
  optionsKey: (providerName) => providerName || 'openai-compatible',
  buildProviderOptions(req) {
    const options: Record<string, unknown> = {};
    // openai-compatible upstreams (OpenRouter) accept the same reasoning
    // field under the provider namespace.
    if (typeof req.reasoningEffort === 'string') options.reasoningEffort = req.reasoningEffort;
    Object.assign(options, extraOpenAiFields(req.raw, 'openai-compatible'));
    const strict = strictJsonSchemaField(req.raw);
    if (strict !== undefined) options.strictJsonSchema = strict;
    return options;
  },
  defaultMaxTokens: () => undefined,
  supportsResponseFormat: true,
};

const anthropicAdapter: ProviderAdapter = {
  optionsKey: () => 'anthropic',
  buildProviderOptions(req) {
    const options: AnthropicProviderOptions = {};
    const thinking = resolveThinkingRequest(req.raw, req.reasoningEffort);
    if (thinking) Object.assign(options, applyAnthropicThinking(thinking));
    return options;
  },
  defaultMaxTokens(req) {
    const thinking = resolveThinkingRequest(req.raw, req.reasoningEffort);
    return thinking ? DEFAULT_MAX_TOKENS_WITH_THINKING : 4096;
  },
  supportsResponseFormat: false,
  applyCaching: (system, messages, tools) =>
    applyAnthropicPromptCaching(system, messages, tools, 'anthropic'),
};

const bedrockAdapter: ProviderAdapter = {
  optionsKey: () => 'bedrock',
  buildProviderOptions(req) {
    const options: BedrockProviderOptions = {};
    const thinking = resolveThinkingRequest(req.raw, req.reasoningEffort);
    if (thinking) {
      // Mirrors this adapter's own `defaultMaxTokens`: when a thinking budget
      // is present, the EFFECTIVE max tokens for this request is always
      // `explicitMaxTokens ?? DEFAULT_MAX_TOKENS_WITH_THINKING` (the plain
      // 4096 default never applies once thinking is on) — needed here too so
      // the budget clamp below matches the ceiling the orchestrator actually
      // sends as `maxOutputTokens`.
      const maxTokens = req.explicitMaxTokens ?? DEFAULT_MAX_TOKENS_WITH_THINKING;
      Object.assign(options, applyBedrockThinking(thinking, maxTokens));
    }
    return options;
  },
  defaultMaxTokens(req) {
    const thinking = resolveThinkingRequest(req.raw, req.reasoningEffort);
    return thinking ? DEFAULT_MAX_TOKENS_WITH_THINKING : 4096;
  },
  supportsResponseFormat: false,
  applyCaching: (system, messages, tools) =>
    applyAnthropicPromptCaching(system, messages, tools, 'bedrock'),
};

const ADAPTERS: Record<AiSdkFamily, ProviderAdapter> = {
  openai: openAiAdapter,
  'openai-compatible': openAiCompatibleAdapter,
  anthropic: anthropicAdapter,
  bedrock: bedrockAdapter,
};

export function buildAiSdkArgs(
  body: Record<string, unknown>,
  family: AiSdkFamily,
  opts: {
    // Applied only when the request carries no explicit reasoning effort of
    // its own (flat `reasoning_effort` or nested `reasoning.effort`) — Codex
    // always sends a reasoning effort (native transport's `chatToResponses`
    // defaults to 'low'; see openai-responses/request.ts), so callUpstreamViaAiSdk
    // passes this for Codex descriptors instead of duplicating that default here.
    defaultReasoningEffort?: string;
    // The exact provider name model.ts passed to `createOpenAICompatible`
    // (`descriptor.provider`) — needed to key providerOptions correctly for
    // the 'openai-compatible' family (see the ProviderAdapter interface doc
    // comment above). Ignored for every other family.
    providerName?: string;
  } = {},
): AiSdkCallArgs {
  const req = normalizeRequest(body, opts);
  const adapter = ADAPTERS[family];

  // The accumulator below is built with `unknown` values (an adapter's
  // fields — logit_bias, metadata, prediction, a client-supplied JSON
  // Schema — come straight from an already-parsed JSON request body, so
  // they're structurally JSON-safe even though the body's declared type is
  // `Record<string, unknown>`, not `JSONValue`) — cast once at the boundary
  // below rather than threading `JSONValue` through every adapter.
  const providerOptions: Record<string, Record<string, unknown>> = {};
  const rawFields = adapter.buildProviderOptions(req, opts.providerName);
  const definedFields = Object.entries(rawFields).filter(([, value]) => value !== undefined);
  if (definedFields.length) {
    providerOptions[adapter.optionsKey(opts.providerName)] = Object.fromEntries(definedFields);
  }

  const maxTokens = req.explicitMaxTokens ?? adapter.defaultMaxTokens(req);

  const stop = body.stop;
  const stopSequences =
    typeof stop === 'string' ? [stop] : Array.isArray(stop) ? (stop as string[]) : undefined;

  let system = req.system;
  let tools = req.tools;
  if (adapter.applyCaching) {
    const cached = adapter.applyCaching(system, req.messages, tools);
    system = cached.system;
    tools = cached.tools;
  }

  let output: AiSdkOutput | undefined;
  if (adapter.supportsResponseFormat) {
    const responseFormat = responseFormatFromBody(body);
    if (responseFormat) output = buildResponseFormatOutput(responseFormat);
  }

  return {
    system,
    messages: req.messages,
    tools,
    toolChoice: req.toolChoice,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    maxOutputTokens: maxTokens,
    stopSequences,
    seed: typeof body.seed === 'number' ? body.seed : undefined,
    frequencyPenalty:
      typeof body.frequency_penalty === 'number' ? body.frequency_penalty : undefined,
    presencePenalty: typeof body.presence_penalty === 'number' ? body.presence_penalty : undefined,
    output,
    providerOptions: (Object.keys(providerOptions).length ? providerOptions : undefined) as
      | Record<string, Record<string, JSONValue>>
      | undefined,
  };
}
