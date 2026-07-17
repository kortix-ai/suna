import { jsonSchema, tool, type ModelMessage, type ToolChoice, type ToolSet } from 'ai';
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
  providerOptions?: Record<string, Record<string, string>>;
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

type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: URL | string };

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
export function toModelMessages(rawMessages: unknown): { system?: string; messages: ModelMessage[] } {
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

const REASONING_FAMILY_KEY: Record<AiSdkFamily, string> = {
  openai: 'openai',
  'openai-compatible': 'openai',
  anthropic: 'anthropic',
  bedrock: 'bedrock',
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

  const providerOptions: Record<string, Record<string, string>> = {};
  // Accepts both the chat/completions field (`reasoning_effort: string`) and
  // the Responses-style nested shape (`reasoning: { effort: string }`) some
  // callers (opencode) send directly — same helper route-kind.ts uses to make
  // the identical decision for the native transport.
  const reasoningEffort = reasoningEffortFromBody(body) ?? opts.defaultReasoningEffort;
  if (typeof reasoningEffort === 'string') {
    // The AI SDK's OpenAI provider strips temperature and other unsupported params
    // for reasoning models on its own — we only forward the effort. openai-compatible
    // upstreams (OpenRouter) accept the same field under the provider namespace.
    providerOptions[REASONING_FAMILY_KEY[family]] = { reasoningEffort };
  }

  return {
    system,
    messages,
    tools,
    toolChoice,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    maxOutputTokens: maxTokens,
    stopSequences,
    providerOptions: Object.keys(providerOptions).length ? providerOptions : undefined,
  };
}
