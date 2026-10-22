import { type CatalogModel, clampGenerationConfig } from '@kortix/llm-catalog';
import type { JSONValue, ModelMessage, ToolChoice, ToolSet } from 'ai';
import { reasoningEffort as reasoningEffortFromBody } from '../route-kind';
import { toModelMessages, toToolChoice, toToolSet } from './messages';
import type { AiSdkFamily } from './model';
import { ADAPTERS, responseFormatFromBody } from './provider-options';

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
function buildResponseFormatOutput(
  responseFormat: NonNullable<ReturnType<typeof responseFormatFromBody>>,
) {
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
// ---------------------------------------------------------------------------
// Normalization: the incoming OpenAI chat.completions body, translated ONCE
// into the family-agnostic shape every adapter below reads from. The four
// capability-gated generation params (reasoning effort, temperature, top_p,
// max output tokens) are ALSO clamped here, in one place, against the resolved
// model's real models.dev capabilities — so adapters and the orchestrator only
// ever read already-gated values. The remaining CallSettings-equivalent params
// (stop/seed/penalties) carry no per-model capability, so they stay read
// straight off `raw` in the orchestrator.
export interface NormalizedRequest {
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
  // Dropped when a resolved model publishes no matching effort tier (gating).
  reasoningEffort: string | undefined;
  // Client-supplied sampling params. Dropped when the resolved model rejects a
  // custom temperature/top_p (models.dev `temperature:false`, e.g. gpt-5.6-sol);
  // clamped to [0,2]/[0,1] otherwise — read by the orchestrator instead of the
  // raw body so gating lives in exactly one place.
  temperature: number | undefined;
  topP: number | undefined;
  // `max_tokens` / `max_completion_tokens`, whichever is present — always
  // wins over any family default (see each adapter's `defaultMaxTokens`).
  // Clamped to the model's `limit.output` ceiling when one is known.
  explicitMaxTokens: number | undefined;
  // The upstream model id (`descriptor.resolvedModel`), e.g.
  // `global.openai.gpt-5.6-sol` vs `us.anthropic.claude-fable-5`. Gates the
  // bedrock adapter's Anthropic-Claude-only Converse primitives (cachePoint,
  // reasoningConfig:adaptive) — a single Bedrock family covers Claude AND
  // non-Claude (OpenAI/Nova/Meta) models, and only Claude accepts those fields.
  resolvedModel: string | undefined;
  // The resolved catalog model, threaded through so an adapter's
  // `defaultMaxTokens` can default to the model's REAL output ceiling
  // (`limit.output`, e.g. 128000) instead of a fixed 32000/4096 when the client
  // sent no max_tokens — a fixed cap far below the ceiling truncates Claude
  // mid-answer once adaptive thinking eats the budget. Absent → the fixed
  // fallback (preserves pre-gating behavior for unresolved models).
  model: CatalogModel | undefined;
}

function normalizeRequest(
  body: Record<string, unknown>,
  opts: { defaultReasoningEffort?: string; model?: CatalogModel; resolvedModel?: string },
): NormalizedRequest {
  const { system, messages } = toModelMessages(body.messages);
  const tools = toToolSet(body.tools);
  const toolChoice = tools ? toToolChoice(body.tool_choice) : undefined;

  // Raw per-request generation params, before capability gating.
  let reasoningEffort = reasoningEffortFromBody(body) ?? opts.defaultReasoningEffort;
  let temperature = typeof body.temperature === 'number' ? body.temperature : undefined;
  let topP = typeof body.top_p === 'number' ? body.top_p : undefined;
  let explicitMaxTokens =
    (typeof body.max_tokens === 'number' ? body.max_tokens : undefined) ??
    (typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined);

  // Gate ONCE against the resolved model's real capabilities, REUSING the
  // canonical clamp from @kortix/llm-catalog — the exact gate the host already
  // runs on route DEFAULTS (see routing/resolve-route.ts), now applied to the
  // client-supplied values that path never touched. Only when a model is known:
  // `clampGenerationConfig` treats an unknown model as "supports nothing" and
  // would drop every field, so absence is a deliberate NO-OP (permissive —
  // preserves the pre-gating behavior every existing caller relies on).
  if (opts.model) {
    const gated = clampGenerationConfig(
      { reasoningEffort, temperature, topP, maxOutputTokens: explicitMaxTokens },
      opts.model,
    );
    reasoningEffort = gated.reasoningEffort;
    temperature = gated.temperature;
    topP = gated.topP;
    explicitMaxTokens = gated.maxOutputTokens;
  }

  return {
    raw: body,
    system,
    messages,
    tools,
    toolChoice,
    reasoningEffort,
    temperature,
    topP,
    explicitMaxTokens,
    resolvedModel: opts.resolvedModel,
    model: opts.model,
  };
}

export type BuildAiSdkOptions = {
  defaultReasoningEffort?: string;
  providerName?: string;
  model?: CatalogModel;
  resolvedModel?: string;
};

export function buildAiSdkArgs(
  body: Record<string, unknown>,
  family: AiSdkFamily,
  opts: BuildAiSdkOptions = {},
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
    providerOptions[adapter.optionsKey] = Object.fromEntries(definedFields);
  }

  // Codex's ChatGPT backend (`https://chatgpt.com/backend-api/codex/responses`)
  // REJECTS `max_output_tokens` outright — it 400s the whole request with
  // `{"detail":"Unsupported parameter: max_output_tokens"}` (captured live via
  // the error-detail path). @ai-sdk/openai's `.responses()` serializes
  // `maxOutputTokens` → wire `max_output_tokens`, so any turn that carries a
  // token cap dies. Requests with NO cap (a bare "hi") slip through, which is
  // why simple probes passed while every real opencode turn — which always
  // sends one — 400'd. The backend manages its own output budget, so dropping
  // the cap for Codex is the correct behaviour, not a workaround. Codex-only:
  // the real OpenAI platform API DOES accept max_output_tokens, so plain
  // `openai` must keep sending it.
  const maxTokens =
    opts.providerName === 'openai-codex'
      ? undefined
      : (req.explicitMaxTokens ?? adapter.defaultMaxTokens(req));

  const stop = body.stop;
  const stopSequences =
    typeof stop === 'string' ? [stop] : Array.isArray(stop) ? (stop as string[]) : undefined;

  let system = req.system;
  let tools = req.tools;
  if (adapter.applyCaching) {
    const cached = adapter.applyCaching(req, system, req.messages, tools);
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
    // Already capability-gated in normalizeRequest (dropped/clamped per the
    // resolved model) — read off `req`, never the raw body, so a model that
    // rejects a custom temperature/top_p never sees one.
    temperature: req.temperature,
    topP: req.topP,
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
