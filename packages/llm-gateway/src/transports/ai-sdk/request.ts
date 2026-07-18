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

// Everything the AI-SDK engine needs to drive `streamText`/`generateText`,
// derived once from the incoming OpenAI chat.completions body. The AI SDK owns
// per-provider quirks from here on (endpoint, param names, tool translation).
export interface AiSdkCallArgs {
  system?: string;
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

// Which `providerOptions` key each family's AI-SDK provider PACKAGE itself
// reads back out — NOT an arbitrary label. Getting this wrong means the
// options object is built but never consumed (silently inert):
//  - 'openai'/'anthropic'/'bedrock': each package's own name.
//  - 'openai-compatible': `createOpenAICompatible`'s chat model reads
//    `providerOptions[<the exact `name` model.ts passed to
//    createOpenAICompatible>]` (its `providerOptionsName` getter — see
//    @ai-sdk/openai-compatible's chat-language-model.js), i.e.
//    `descriptor.provider` (e.g. 'openrouter'), never the literal string
//    'openai'.
//
// Defect 5 (2026-07-17, found auditing this parity piece): the previous
// version of this map sent 'openai-compatible' calls' reasoningEffort to
// providerOptions.openai — a key @ai-sdk/openai-compatible's chat model
// NEVER reads (it only parses `providerOptions['openai-compatible']`,
// `['openaiCompatible']`, `[providerOptionsName]`, and the camelCase of the
// last one — never a bare `'openai'`). reasoning_effort was therefore
// silently dropped for every OpenRouter-class (openai-compatible) request
// carrying one — a real request ↔ upstream-call parity gap, never caught
// because the only existing reasoning_effort test drove family:'openai'.
function providerOptionsKeyFor(family: AiSdkFamily, providerName: string | undefined): string {
  if (family === 'openai-compatible') return providerName || 'openai-compatible';
  if (family === 'anthropic') return 'anthropic';
  if (family === 'bedrock') return 'bedrock';
  return 'openai';
}

function mergeProviderOptions(
  target: Record<string, Record<string, unknown>>,
  key: string,
  fields: Record<string, unknown>,
): void {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  target[key] = { ...target[key], ...Object.fromEntries(entries) };
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
  family: AiSdkFamily,
): Record<string, unknown> {
  if (family !== 'openai' && family !== 'openai-compatible') return {};

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

// Only the two families whose NATIVE transport is openai-compat (the
// verbatim body-forwarding path — see openai-compat/index.ts) ever actually
// deliver `response_format` to an upstream today: genuine OpenAI and any
// generic OpenAI-compatible upstream (OpenRouter, Groq, self-hosted...).
// anthropic/bedrock's native transports (anthropic/request.ts's
// buildAnthropicCorePayload, shared by bedrock) never read
// `body.response_format` at all — it's silently dropped there too — so NOT
// mapping it for those two families here is matching parity, not a gap.
const RESPONSE_FORMAT_FAMILIES: ReadonlySet<AiSdkFamily> = new Set(['openai', 'openai-compatible']);

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
    // the 'openai-compatible' family (see providerOptionsKeyFor above).
    // Ignored for every other family.
    providerName?: string;
  } = {},
): AiSdkCallArgs {
  const { system, messages } = toModelMessages(body.messages);
  const tools = toToolSet(body.tools);
  const toolChoice = tools ? toToolChoice(body.tool_choice) : undefined;

  const maxTokens =
    (typeof body.max_tokens === 'number' ? body.max_tokens : undefined) ??
    (typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined) ??
    (family === 'anthropic' || family === 'bedrock' ? 4096 : undefined);

  const stop = body.stop;
  const stopSequences =
    typeof stop === 'string' ? [stop] : Array.isArray(stop) ? (stop as string[]) : undefined;

  const providerOptionsKey = providerOptionsKeyFor(family, opts.providerName);
  const providerOptions: Record<string, Record<string, unknown>> = {};

  // Accepts both the chat/completions field (`reasoning_effort: string`) and
  // the Responses-style nested shape (`reasoning: { effort: string }`) some
  // callers (opencode) send directly — same helper route-kind.ts uses to make
  // the identical decision for the native transport.
  const reasoningEffort = reasoningEffortFromBody(body) ?? opts.defaultReasoningEffort;
  if (typeof reasoningEffort === 'string') {
    // The AI SDK's OpenAI provider strips temperature and other unsupported params
    // for reasoning models on its own — we only forward the effort. openai-compatible
    // upstreams (OpenRouter) accept the same field under the provider namespace.
    mergeProviderOptions(providerOptions, providerOptionsKey, { reasoningEffort });
  }

  const responseFormat = RESPONSE_FORMAT_FAMILIES.has(family)
    ? responseFormatFromBody(body)
    : undefined;
  let output: AiSdkOutput | undefined;
  if (responseFormat) {
    output = buildResponseFormatOutput(responseFormat);
    if (responseFormat.type === 'json' && responseFormat.schema !== undefined) {
      // Both provider packages default `strictJsonSchema` to `true`
      // (OpenAI Structured Outputs' stricter validation) when the key is
      // absent — but native forwards the client's body verbatim, so an
      // omitted `strict` field reaches OpenAI as ITS OWN default (`false`
      // for chat/completions' json_schema mode), not the AI SDK's default.
      // Only ever honor an EXPLICIT `strict:true` from the client; never let
      // the ai-sdk engine be stricter than native would have been for the
      // exact same request.
      const rawStrict = (body.response_format as OpenAiResponseFormatBody | undefined)?.json_schema
        ?.strict;
      mergeProviderOptions(providerOptions, providerOptionsKey, {
        strictJsonSchema: rawStrict === true,
      });
    }
  }

  mergeProviderOptions(providerOptions, providerOptionsKey, extraOpenAiFields(body, family));

  return {
    system,
    messages,
    tools,
    toolChoice,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    maxOutputTokens: maxTokens,
    stopSequences,
    seed: typeof body.seed === 'number' ? body.seed : undefined,
    frequencyPenalty:
      typeof body.frequency_penalty === 'number' ? body.frequency_penalty : undefined,
    presencePenalty: typeof body.presence_penalty === 'number' ? body.presence_penalty : undefined,
    output,
    // The accumulator above is built with `unknown` values (its inputs —
    // logit_bias, metadata, prediction, a client-supplied JSON Schema — come
    // straight from an already-parsed JSON request body, so they're
    // structurally JSON-safe even though the JSON body's declared type is
    // `Record<string, unknown>`, not `JSONValue`) — cast once at the
    // boundary rather than threading `JSONValue` through every helper above.
    providerOptions: (Object.keys(providerOptions).length ? providerOptions : undefined) as
      | Record<string, Record<string, JSONValue>>
      | undefined,
  };
}
