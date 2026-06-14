// Pure translation between the OpenAI/OpenRouter chat-completions wire format
// (what opencode's `@ai-sdk/openai-compatible` provider sends) and the AWS
// Bedrock Converse API shape. No AWS SDK / no I/O here so this stays trivially
// unit-testable; the SDK calls live in bedrock-client.ts.

import type { ExtractedUsage } from './usage-extractor';

/* ────────────────────────────── request ────────────────────────────── */

interface OpenAiTextPart {
  type: 'text';
  text: string;
}
interface OpenAiImagePart {
  type: 'image_url';
  image_url: { url: string };
}
type OpenAiContentPart = OpenAiTextPart | OpenAiImagePart | Record<string, unknown>;

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiMessage {
  role: string;
  content?: string | OpenAiContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

// Loosely-typed mirrors of the Bedrock Converse types we emit. We avoid
// importing the SDK's types here so this module has zero runtime deps.
export interface ConverseRequest {
  modelId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }>;
  system?: Array<{ text: string }>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  toolConfig?: {
    tools: Array<{
      toolSpec: { name: string; description?: string; inputSchema: { json: unknown } };
    }>;
    toolChoice?: Record<string, unknown>;
  };
  additionalModelRequestFields?: Record<string, unknown>;
}

const IMAGE_FORMATS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function decodeImagePart(url: string): { format: string; bytes: Uint8Array } | null {
  // data:image/png;base64,XXXX
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const format = IMAGE_FORMATS[m[1].toLowerCase()];
  if (!format) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { format, bytes };
  } catch {
    return null;
  }
}

function contentToBlocks(content: OpenAiMessage['content']): unknown[] {
  if (content == null) return [];
  if (typeof content === 'string') {
    return content.length ? [{ text: content }] : [];
  }
  const blocks: unknown[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = (part as { type?: string }).type;
    if (type === 'text' && typeof (part as OpenAiTextPart).text === 'string') {
      if ((part as OpenAiTextPart).text.length) blocks.push({ text: (part as OpenAiTextPart).text });
    } else if (type === 'image_url') {
      const url = (part as OpenAiImagePart).image_url?.url;
      const img = typeof url === 'string' ? decodeImagePart(url) : null;
      if (img) blocks.push({ image: { format: img.format, source: { bytes: img.bytes } } });
    }
  }
  return blocks;
}

function parseToolArguments(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/**
 * Translate an OpenAI chat-completions body into a Bedrock Converse request.
 * `reasoningBudget` (when > 0) enables Anthropic extended thinking.
 */
export function openaiToConverse(
  body: Record<string, unknown>,
  modelId: string,
  reasoningBudget?: number,
): ConverseRequest {
  const messages = Array.isArray(body.messages) ? (body.messages as OpenAiMessage[]) : [];

  const system: Array<{ text: string }> = [];
  const converseMessages: ConverseRequest['messages'] = [];

  const pushMessage = (role: 'user' | 'assistant', content: unknown[]) => {
    if (!content.length) return;
    const last = converseMessages[converseMessages.length - 1];
    // Bedrock requires strictly alternating roles; merge consecutive same-role
    // turns (e.g. a tool result followed by a user message) into one.
    if (last && last.role === role) {
      last.content.push(...content);
    } else {
      converseMessages.push({ role, content });
    }
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;

    if (role === 'system' || role === 'developer') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : contentToBlocks(msg.content)
              .map((b) => (b as { text?: string }).text ?? '')
              .join('');
      if (text) system.push({ text });
      continue;
    }

    if (role === 'tool') {
      const toolResult = {
        toolResult: {
          toolUseId: msg.tool_call_id ?? '',
          content:
            typeof msg.content === 'string'
              ? [{ text: msg.content }]
              : contentToBlocks(msg.content),
        },
      };
      pushMessage('user', [toolResult]);
      continue;
    }

    if (role === 'assistant') {
      const blocks = contentToBlocks(msg.content);
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (call?.function?.name) {
            blocks.push({
              toolUse: {
                toolUseId: call.id ?? call.function.name,
                name: call.function.name,
                input: parseToolArguments(call.function.arguments),
              },
            });
          }
        }
      }
      pushMessage('assistant', blocks);
      continue;
    }

    // user (and any other role) → user turn
    pushMessage('user', contentToBlocks(msg.content));
  }

  const req: ConverseRequest = { modelId, messages: converseMessages };
  if (system.length) req.system = system;

  const inferenceConfig: NonNullable<ConverseRequest['inferenceConfig']> = {};
  if (typeof body.max_tokens === 'number') inferenceConfig.maxTokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === 'number')
    inferenceConfig.maxTokens = body.max_completion_tokens;
  // Extended thinking requires temperature=1 and no topP; honor that.
  if (reasoningBudget && reasoningBudget > 0) {
    inferenceConfig.temperature = 1;
  } else {
    if (typeof body.temperature === 'number') inferenceConfig.temperature = body.temperature;
    if (typeof body.top_p === 'number') inferenceConfig.topP = body.top_p;
  }
  if (typeof body.stop === 'string') inferenceConfig.stopSequences = [body.stop];
  else if (Array.isArray(body.stop))
    inferenceConfig.stopSequences = body.stop.filter((s): s is string => typeof s === 'string');
  if (Object.keys(inferenceConfig).length) req.inferenceConfig = inferenceConfig;

  // Tools
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length) {
    const toolSpecs = tools
      .map((t) => {
        const fn = (t as { function?: { name?: string; description?: string; parameters?: unknown } })
          .function;
        if (!fn?.name) return null;
        return {
          toolSpec: {
            name: fn.name,
            description: fn.description,
            inputSchema: { json: fn.parameters ?? { type: 'object', properties: {} } },
          },
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
    if (toolSpecs.length) {
      req.toolConfig = { tools: toolSpecs };
      const tc = body.tool_choice;
      if (tc === 'required' || tc === 'any') req.toolConfig.toolChoice = { any: {} };
      else if (tc === 'auto') req.toolConfig.toolChoice = { auto: {} };
      else if (tc && typeof tc === 'object') {
        const name = (tc as { function?: { name?: string } }).function?.name;
        if (name) req.toolConfig.toolChoice = { tool: { name } };
      }
    }
  }

  if (reasoningBudget && reasoningBudget > 0) {
    req.additionalModelRequestFields = {
      ...(req.additionalModelRequestFields ?? {}),
      thinking: { type: 'enabled', budget_tokens: reasoningBudget },
    };
  }

  return req;
}

/* ────────────────────────────── response ───────────────────────────── */

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  content_filtered: 'content_filter',
  guardrail_intervened: 'content_filter',
};

export function mapStopReason(reason: string | undefined): string {
  if (!reason) return 'stop';
  return STOP_REASON_MAP[reason] ?? 'stop';
}

export function usageFromConverse(
  usage: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number } | undefined,
): ExtractedUsage {
  return {
    promptTokens: usage?.inputTokens ?? 0,
    completionTokens: usage?.outputTokens ?? 0,
    cachedTokens: usage?.cacheReadInputTokens ?? 0,
  };
}

interface ConverseContentBlock {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input?: unknown };
  reasoningContent?: { reasoningText?: { text?: string } };
}

/**
 * Translate a (non-streaming) Bedrock Converse response into an OpenAI
 * chat.completion object, including a usage block in OpenAI shape so the
 * gateway's shared usage-extractor handles it unchanged.
 */
export function converseToOpenai(
  output: {
    output?: { message?: { role?: string; content?: ConverseContentBlock[] } };
    stopReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number };
  },
  model: string,
  requestId: string,
): Record<string, unknown> {
  const blocks = output.output?.message?.content ?? [];
  let text = '';
  let reasoning = '';
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];

  for (const b of blocks) {
    if (typeof b.text === 'string') text += b.text;
    else if (b.reasoningContent?.reasoningText?.text)
      reasoning += b.reasoningContent.reasoningText.text;
    else if (b.toolUse?.name) {
      toolCalls.push({
        id: b.toolUse.toolUseId ?? b.toolUse.name,
        type: 'function',
        function: { name: b.toolUse.name, arguments: JSON.stringify(b.toolUse.input ?? {}) },
      });
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const u = output.usage ?? {};
  return {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(output.stopReason),
      },
    ],
    usage: {
      prompt_tokens: u.inputTokens ?? 0,
      completion_tokens: u.outputTokens ?? 0,
      total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
      prompt_tokens_details: { cached_tokens: u.cacheReadInputTokens ?? 0 },
    },
  };
}

/* ─────────────────────────────── streaming ─────────────────────────── */

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Stateful translator for a Bedrock ConverseStream into OpenAI SSE
 * `chat.completion.chunk` events. Feed each Converse stream event; collect the
 * emitted SSE strings. Call `done()` to flush the terminating `[DONE]`.
 */
export function makeStreamTranslator(model: string, requestId: string) {
  const id = `chatcmpl-${requestId}`;
  const created = Math.floor(Date.now() / 1000);
  // Maps a Bedrock contentBlockIndex → the OpenAI tool_call index (only for
  // toolUse blocks), so streamed argument deltas attach to the right call.
  const toolIndexByBlock = new Map<number, number>();
  let nextToolIndex = 0;

  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    sse({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason }],
    });

  return {
    /** Emit the leading role chunk. */
    start(): string {
      return chunk({ role: 'assistant', content: '' });
    },

    /** Translate one Bedrock stream event; returns 0+ SSE strings. */
    event(ev: Record<string, any>): string[] {
      const out: string[] = [];

      if (ev.contentBlockStart) {
        const idx = ev.contentBlockStart.contentBlockIndex;
        const tu = ev.contentBlockStart.start?.toolUse;
        if (tu) {
          const toolIndex = nextToolIndex++;
          toolIndexByBlock.set(idx, toolIndex);
          out.push(
            chunk({
              tool_calls: [
                {
                  index: toolIndex,
                  id: tu.toolUseId,
                  type: 'function',
                  function: { name: tu.name, arguments: '' },
                },
              ],
            }),
          );
        }
      } else if (ev.contentBlockDelta) {
        const idx = ev.contentBlockDelta.contentBlockIndex;
        const d = ev.contentBlockDelta.delta ?? {};
        if (typeof d.text === 'string') {
          out.push(chunk({ content: d.text }));
        } else if (d.reasoningContent?.text) {
          out.push(chunk({ reasoning_content: d.reasoningContent.text }));
        } else if (d.toolUse && typeof d.toolUse.input === 'string') {
          const toolIndex = toolIndexByBlock.get(idx) ?? 0;
          out.push(
            chunk({
              tool_calls: [{ index: toolIndex, function: { arguments: d.toolUse.input } }],
            }),
          );
        }
      } else if (ev.messageStop) {
        out.push(chunk({}, mapStopReason(ev.messageStop.stopReason)));
      } else if (ev.metadata?.usage) {
        const u = ev.metadata.usage;
        out.push(
          sse({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: u.inputTokens ?? 0,
              completion_tokens: u.outputTokens ?? 0,
              total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
              prompt_tokens_details: { cached_tokens: u.cacheReadInputTokens ?? 0 },
            },
          }),
        );
      }

      return out;
    },

    done(): string {
      return 'data: [DONE]\n\n';
    },
  };
}
