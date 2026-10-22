import type { BedrockProviderOptions } from '@ai-sdk/amazon-bedrock';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import type { OpenAIChatLanguageModelOptions } from '@ai-sdk/openai';
import type { JSONValue, ModelMessage, ToolSet } from 'ai';
import type { AiSdkSystemInstruction, NormalizedRequest } from './build-args';
import type { AiSdkFamily } from './model';

type AiSdkResponseFormat =
  | { type: 'text' }
  | { type: 'json'; schema?: unknown; name?: string; description?: string };

// OpenAI wire fields that carry no AI-SDK top-level CallSettings equivalent
// (unlike temperature/topP/stopSequences/seed/frequencyPenalty/
// presencePenalty, which the SDK core exposes directly — see the seed/
// penalty mapping in buildAiSdkArgs below). @ai-sdk/openai's own schema
// (openaiLanguageModelChatOptions) recognizes each of these under
// providerOptions.openai by CAMELCASE name and re-serializes them back to the
// identical wire field.
// Deliberately NOT mapped: `n` (multiple choices) — this transport only ever
// reconstructs ONE choice from AI-SDK's single-result `streamText`/
// `generateText` (see sse.ts/index.ts), so setting n>1 would silently bill for
// completions the client never receives instead of doing nothing; and
// `modalities` (audio output) — no current caller (opencode/agents) requests
// non-text output and AI SDK core has no hook for it on streamText/generateText.
function extraOpenAiFields(body: Record<string, unknown>): Record<string, unknown> {
  const logitBias = body.logit_bias;
  const logprobs = body.logprobs;
  const topLogprobs = body.top_logprobs;
  const parallelToolCalls = body.parallel_tool_calls;
  const user = body.user;
  const serviceTier = body.service_tier;
  const metadata = body.metadata;
  const prediction = body.prediction;

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
// the wire (see @ai-sdk/openai's getArgs:
// `schema != null ? {type:'json_schema',...} : {type:'json_object'}`).
export function responseFormatFromBody(
  body: Record<string, unknown>,
): AiSdkResponseFormat | undefined {
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

// Only the openai family delivers `response_format` to an upstream through
// this engine (OpenAI-compatible upstreams receive the client body verbatim on
// the direct path). anthropic/bedrock's native transports (anthropic/request.ts's
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
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: resolved.effort,
  };
}

// @ai-sdk/amazon-bedrock — current-gen Bedrock Claude (Sonnet 5, Opus 4.5+/4.8)
// REJECTS the legacy `reasoningConfig:{type:"enabled", budgetTokens}` shape with
// the SAME 400 as direct Anthropic ("`thinking.type.enabled` is not supported
// for this model. Use `thinking.type.adaptive` and `output_config.effort`").
// Bedrock's Converse API HAS adopted the adaptive surface: @ai-sdk/amazon-bedrock
// serializes `reasoningConfig:{type:"adaptive", maxReasoningEffort}` to the wire's
// `additionalModelRequestFields.thinking={type:"adaptive"}` + `output_config.effort`
// — the exact pair the error demands. So mirror `applyAnthropicThinking`: drive
// extended thinking through ADAPTIVE + an effort tier (the model manages its own
// budget; the caller's maxOutputTokens bump gives thinking + answer headroom).
// Verified against real Bedrock (us-east-1): `enabled` 400s on Sonnet 5 / Opus
// 4.6 / 4.8; `adaptive` + effort returns 200 on all three. Every managed Bedrock
// Claude is >= 4.6 (adaptive-capable) and pre-adaptive Claude (3.7) is EOL on
// Bedrock, so no served model still needs the old `enabled` shape.
function applyBedrockThinking(
  resolved: ResolvedThinking,
): Pick<BedrockProviderOptions, 'reasoningConfig'> {
  return {
    reasoningConfig: {
      type: 'adaptive',
      maxReasoningEffort: resolved.effort,
      display: 'summarized',
    },
  };
}

// A Bedrock-family model resolves to one of two DIFFERENT wire contracts.
// Anthropic Claude on Bedrock speaks the Converse Anthropic surface: `cachePoint`
// (prompt caching) and `reasoningConfig:{type:'adaptive'}` (extended thinking)
// are Claude-Converse-only primitives. OpenAI-on-Bedrock (`global.openai.*`),
// Amazon Nova, Meta, and DeepSeek do NOT accept them — Bedrock rejects the
// request with `403 "You invoked an unsupported model or your request did not
// allow prompt caching."`. Gate both primitives on the model id, mirroring
// model.ts's `isNovaModel` regex (the existing Bedrock model-id discriminator).
function isBedrockClaudeModel(resolvedModel: string | undefined): boolean {
  return /anthropic\.claude/i.test(resolvedModel ?? '');
}

// OpenAI models on Bedrock (`global.openai.gpt-5.6-*`, `openai.gpt-5.5`,
// `openai.gpt-oss-*`) are served by Bedrock core (Converse). The reasoning
// knob travels as `additionalModelRequestFields.reasoning: { effort }` — the
// OpenAI Responses shape. VERIFIED against real Bedrock (us-west-2,
// 2026-08-25, global.openai.gpt-5.6-sol): `reasoning.effort` returns 200 for
// every published tier (none/low/medium/high/xhigh/max) and 400
// `unsupported_value` for an unpublished one (`minimal`); the flat
// `reasoning_effort` that @ai-sdk/amazon-bedrock 5.0.59 emits for its
// `isOpenAIModel` branch is REJECTED by GPT-5.6 with 400 `unknown_parameter`
// (gpt-oss-120b accepts both shapes, so the nested one is the universal
// OpenAI-on-Bedrock wire). `reasoningEffort`, `reasoningConfig` and
// `thinking` are all `unknown_parameter` too. `summary: 'auto'` makes the
// model return its reasoning as a content block (the thinking the composer
// shows), matching opencode's `reasoningSummary: 'auto'` for OpenAI. Before
// this branch existed the bedrock adapter returned `{}` for every non-Claude
// model, so a client's `reasoning_effort` (or the project's configured
// default) was silently dropped for GPT-5.6 on Bedrock.
function isBedrockOpenAiModel(resolvedModel: string | undefined): boolean {
  return /(^|\.)openai\./i.test(resolvedModel ?? '');
}

// Models that answered `unknown_parameter` for the reasoning field once. The
// wire shape below is verified (#6893), but the next provider surface that
// publishes an OpenAI ladder and rejects the field must cost one retry, never
// the turn: the pipeline notes a rejection here and re-dispatches once without
// it; every later request to that model skips the field.
const bedrockOpenAiReasoningEffortRejected = new Set<string>();
export function noteBedrockOpenAiRejectsReasoningEffort(resolvedModel: string): void {
  bedrockOpenAiReasoningEffortRejected.add(resolvedModel);
}
export function bedrockOpenAiRejectsReasoningEffort(resolvedModel: string | undefined): boolean {
  return !!resolvedModel && bedrockOpenAiReasoningEffortRejected.has(resolvedModel);
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
// Per-provider adapter registry.
//
// Each AI-SDK family (see model.ts's `AiSdkFamily`) has its own wire
// contract — a different `providerOptions` key, a different reasoning
// mechanism, different defaults, different caching primitives, and only one
// of them ever sees `response_format`. Each family owns ONE adapter
// implementing this interface, keyed off `AiSdkFamily` in `ADAPTERS` below;
// `buildAiSdkArgs` is a thin orchestrator that never branches on family
// itself — it only ever asks "the adapter for this family" to do the
// family-specific work.
//
// `buildProviderOptions`'s return type is intentionally `Record<string,
// unknown>` at the interface level (the families have genuinely different
// shapes) — but every adapter below builds and returns a value first typed
// against its OWN package's exported provider-options type
// (`AnthropicProviderOptions`, `BedrockProviderOptions`,
// `OpenAIChatLanguageModelOptions`), so assigning a field the SDK doesn't
// recognize, or misspelling one, is a compile error at the point it's
// constructed.
export interface ProviderAdapter {
  // Which `providerOptions` key this family's AI-SDK provider PACKAGE itself
  // reads back out — NOT an arbitrary label. Getting this wrong means the
  // options object is built but never consumed (silently inert).
  optionsKey: string;
  // Reasoning/thinking + family-specific extra fields + strictJsonSchema,
  // typed against this family's own SDK option type (see the interface doc
  // comment above). Returned fields with value `undefined` are dropped by
  // the orchestrator before being attached — an adapter never needs to omit
  // a key itself just to avoid sending it.
  buildProviderOptions(req: NormalizedRequest, providerName?: string): Record<string, unknown>;
  // maxOutputTokens to use when the client sent no explicit max_tokens/
  // max_completion_tokens. `undefined` (openai) means "let the AI SDK /
  // upstream default apply" — unlike anthropic/bedrock, it never required an
  // explicit ceiling before this transport existed.
  defaultMaxTokens(req: NormalizedRequest): number | undefined;
  // Whether this family's native transport ever forwarded `response_format`
  // to the upstream (see the parity note above `strictJsonSchemaField`) —
  // gates whether the orchestrator builds an `AiSdkOutput` at all.
  supportsResponseFormat: boolean;
  // Prompt-cache breakpoint insertion (anthropic/bedrock only). Absent on
  // families with no caching primitive here (openai). Takes
  // `req` so the bedrock adapter can gate the Claude-only `cachePoint` on the
  // resolved model id (see `isBedrockClaudeModel`).
  applyCaching?(
    req: NormalizedRequest,
    system: string | AiSdkSystemInstruction | undefined,
    messages: ModelMessage[],
    tools: ToolSet | undefined,
  ): { system: string | AiSdkSystemInstruction | undefined; tools: ToolSet | undefined };
}

const openAiAdapter: ProviderAdapter = {
  optionsKey: 'openai',
  buildProviderOptions(req, providerName) {
    const options: OpenAIChatLanguageModelOptions = {};
    // The AI SDK's OpenAI provider strips temperature and other unsupported
    // params for reasoning models on its own — we only forward the effort.
    if (typeof req.reasoningEffort === 'string') {
      options.reasoningEffort =
        req.reasoningEffort as OpenAIChatLanguageModelOptions['reasoningEffort'];
    }
    // Codex (ChatGPT subscription) upstream — `https://chatgpt.com/backend-api/codex`
    // — is NOT the public OpenAI platform API. It is stricter, and it rejects a
    // Responses body that omits `store` with a bare `{"error":{"message":"Bad
    // Request","code":400}}` SSE frame naming no field. The deleted native
    // transport set `store: false` UNCONDITIONALLY on every Codex request
    // (transports/openai-responses/request.ts:156, removed in #4943 when the
    // ai-sdk engine became the sole transport); that line was never ported, so
    // the SDK left `store` undefined → dropped from the JSON → every codex/*
    // model 400'd. Restoring exact parity with the transport that worked.
    // Do NOT "clean this up" as redundant: omitted and `false` are different
    // requests to this backend.
    if (providerName === 'openai-codex') options.store = false;
    Object.assign(options, extraOpenAiFields(req.raw));
    if (providerName === 'openai-codex') {
      // Every Codex model reasons, but @ai-sdk/openai detects reasoning models
      // by id prefix (o1/o3/o4-mini/gpt-5). `gpt-6-*` missed it, so the SDK
      // dropped reasoningEffort and sent system prompts as `system` instead of
      // `developer`.
      options.forceReasoning = true;
      // The ChatGPT backend 400s a Responses body that carries `metadata`.
      delete options.metadata;
    }
    const strict = strictJsonSchemaField(req.raw);
    if (strict !== undefined) options.strictJsonSchema = strict;
    return options;
  },
  defaultMaxTokens: () => undefined,
  supportsResponseFormat: true,
};

const anthropicAdapter: ProviderAdapter = {
  optionsKey: 'anthropic',
  buildProviderOptions(req) {
    const options: AnthropicProviderOptions = {};
    const thinking = resolveThinkingRequest(req.raw, req.reasoningEffort);
    if (thinking) Object.assign(options, applyAnthropicThinking(thinking));
    return options;
  },
  // Prefer the model's REAL output ceiling (`limit.output`, e.g. 128000) when
  // the client sent no max_tokens — an injected cap below the ceiling truncates
  // Claude mid-answer once adaptive thinking eats the budget. The 32000/4096
  // stay as the fallback for an unresolved model (unknown ceiling). The
  // client's own explicit max_tokens always wins (see buildAiSdkArgs:
  // `req.explicitMaxTokens ?? adapter.defaultMaxTokens(req)`).
  defaultMaxTokens(req) {
    const ceiling = req.model?.limit?.output;
    const thinking = resolveThinkingRequest(req.raw, req.reasoningEffort);
    return thinking ? (ceiling ?? DEFAULT_MAX_TOKENS_WITH_THINKING) : (ceiling ?? 4096);
  },
  supportsResponseFormat: false,
  applyCaching: (_req, system, messages, tools) =>
    applyAnthropicPromptCaching(system, messages, tools, 'anthropic'),
};

const bedrockAdapter: ProviderAdapter = {
  optionsKey: 'bedrock',
  buildProviderOptions(req) {
    const options: BedrockProviderOptions = {};
    // OpenAI-on-Bedrock: forward the (capability-gated, see normalizeRequest)
    // effort as the OpenAI-native field. Nothing else — `cachePoint` and
    // `reasoningConfig` are Claude-Converse-only and 403 here.
    if (isBedrockOpenAiModel(req.resolvedModel)) {
      if (
        typeof req.reasoningEffort === 'string' &&
        !bedrockOpenAiRejectsReasoningEffort(req.resolvedModel)
      ) {
        options.additionalModelRequestFields = {
          reasoning: { effort: req.reasoningEffort, summary: 'auto' },
        };
      }
      return options;
    }
    // `reasoningConfig:{type:'adaptive'}` is a Claude-Converse-only primitive.
    // Other non-Claude Bedrock models (Nova, Grok, DeepSeek, …) 403 on it —
    // never attach it for them. Their own effort wires are not mapped yet
    // (Nova 2 / Grok 4.6 publish reasoning_options on models.dev; the Converse
    // field shape for them is unverified), so an effort that reaches here is
    // DROPPED. Not refused: #6887 briefly answered 400 `unsupported_param`
    // here, and the first turn of a fresh project on dev proved that opencode
    // sends a default effort for every reasoning-capable model (the user never
    // picked a tier) — refusing the parameter refused the model, including
    // the managed Grok default. Map the wire when it is verified; until then
    // the model runs at its own default.
    if (!isBedrockClaudeModel(req.resolvedModel)) return options;
    const thinking = resolveThinkingRequest(req.raw, req.reasoningEffort);
    // Adaptive thinking carries no token budget to clamp — the model manages
    // its own. `defaultMaxTokens` below still bumps maxOutputTokens so thinking
    // + answer share enough headroom.
    if (thinking) Object.assign(options, applyBedrockThinking(thinking));
    return options;
  },
  // Prefer the model's REAL output ceiling (`limit.output`) when the client
  // sent no max_tokens — an injected cap below the ceiling truncates Claude
  // mid-answer once adaptive thinking eats the budget. The 32000/4096 stay as
  // the fallback for an unresolved model. The client's own explicit max_tokens
  // always wins (see buildAiSdkArgs).
  defaultMaxTokens(req) {
    const ceiling = req.model?.limit?.output;
    const thinking = resolveThinkingRequest(req.raw, req.reasoningEffort);
    return thinking ? (ceiling ?? DEFAULT_MAX_TOKENS_WITH_THINKING) : (ceiling ?? 4096);
  },
  supportsResponseFormat: false,
  // `cachePoint` is a Claude-Converse-only primitive. Non-Claude Bedrock models
  // (`global.openai.*`, Nova, …) 403 on it — pass the system/tools through
  // unchanged for them.
  applyCaching: (req, system, messages, tools) =>
    isBedrockClaudeModel(req.resolvedModel)
      ? applyAnthropicPromptCaching(system, messages, tools, 'bedrock')
      : { system, tools },
};

export const ADAPTERS: Record<AiSdkFamily, ProviderAdapter> = {
  openai: openAiAdapter,
  anthropic: anthropicAdapter,
  bedrock: bedrockAdapter,
};
