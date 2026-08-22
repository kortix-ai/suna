// Anthropic Messages API ingress: translates the Anthropic `/v1/messages`
// request/response/SSE shapes to and from the gateway's internal
// representation, which is always the OpenAI chat.completions shape (the same
// one `handleChatCompletions` consumes and produces). Translation happens
// entirely around the pipeline — auth, billing, routing, failover, and trace
// all still run against the OpenAI-shaped body, exactly as they do for the
// native `/v1/llm/chat/completions` surface.

export type AnthropicContentBlock = Record<string, unknown> & { type: string };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: Record<string, unknown> | string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  // Anthropic's native extended-thinking toggle — a client can explicitly
  // enable it with a token budget (`{type:'enabled', budget_tokens}`) or
  // explicitly turn it OFF (`{type:'disabled'}`). Forwarded verbatim into
  // the internal body (see `anthropicMessagesToChat` below) rather than
  // translated to `reasoning_effort`, because the ai-sdk transport's
  // `resolveAnthropicThinkingBudget` (transports/ai-sdk/request.ts) already
  // reads a raw `body.thinking` FIRST and, when present, never falls
  // through to `reasoning_effort`/a project-configured default — so this is
  // what makes an explicit client `thinking:{type:'disabled'}` immune to a
  // project's configured reasoningEffort default turning thinking back on.
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

const FINISH_REASON_TO_STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
};

function safeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function textFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is AnthropicContentBlock =>
        Boolean(block) &&
        typeof block === 'object' &&
        (block as AnthropicContentBlock).type === 'text',
    )
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('');
}

function anthropicSystemToText(system: unknown): string | undefined {
  const text = textFromBlocks(system);
  return text || undefined;
}

function toolResultContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return textFromBlocks(content);
  if (content == null) return '';
  return JSON.stringify(content);
}

function userBlockToOpenAiContentPart(
  block: AnthropicContentBlock,
): Record<string, unknown> | null {
  if (block.type === 'text')
    return { type: 'text', text: (block as { text?: unknown }).text ?? '' };
  if (block.type === 'image') {
    const source = (block as { source?: Record<string, unknown> }).source ?? {};
    if (source.type === 'base64') {
      const mediaType = source.media_type ?? 'image/png';
      return {
        type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${source.data ?? ''}` },
      };
    }
    if (source.type === 'url') return { type: 'image_url', image_url: { url: source.url ?? '' } };
  }
  return null;
}

// One Anthropic `user` message can carry tool_result blocks (the reply to a
// prior assistant tool_use) interleaved with ordinary text/image blocks. The
// tool_result blocks become their own OpenAI `role: 'tool'` messages — placed
// first so they immediately follow the assistant message with the matching
// `tool_calls`, matching how OpenAI-shaped conversations are structured —
// and any remaining content becomes a separate `role: 'user'` message.
function pushAnthropicUserMessage(message: AnthropicMessage, out: Record<string, unknown>[]): void {
  const { content } = message;
  if (typeof content === 'string') {
    out.push({ role: 'user', content });
    return;
  }
  if (!Array.isArray(content) || content.length === 0) {
    out.push({ role: 'user', content: '' });
    return;
  }

  const toolResults = content.filter((block) => block.type === 'tool_result');
  const otherBlocks = content.filter((block) => block.type !== 'tool_result');

  for (const result of toolResults) {
    out.push({
      role: 'tool',
      tool_call_id: (result as { tool_use_id?: unknown }).tool_use_id,
      content: toolResultContentToString((result as { content?: unknown }).content),
    });
  }

  if (otherBlocks.length) {
    const parts = otherBlocks
      .map(userBlockToOpenAiContentPart)
      .filter((part): part is Record<string, unknown> => part !== null);
    if (parts.length === 1 && parts[0].type === 'text') {
      out.push({ role: 'user', content: parts[0].text });
    } else if (parts.length) {
      out.push({ role: 'user', content: parts });
    }
  }
}

function pushAnthropicAssistantMessage(
  message: AnthropicMessage,
  out: Record<string, unknown>[],
): void {
  const { content } = message;
  const blocks: AnthropicContentBlock[] = Array.isArray(content)
    ? content
    : content
      ? [{ type: 'text', text: content }]
      : [];

  let text = '';
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') text += String((block as { text?: unknown }).text ?? '');
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: (block as { id?: unknown }).id,
        type: 'function',
        function: {
          name: (block as { name?: unknown }).name,
          arguments: JSON.stringify((block as { input?: unknown }).input ?? {}),
        },
      });
    }
  }

  const openAiMessage: Record<string, unknown> = { role: 'assistant', content: text || null };
  if (toolCalls.length) openAiMessage.tool_calls = toolCalls;
  out.push(openAiMessage);
}

function translateAnthropicTools(tools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter(
      (tool): tool is AnthropicTool =>
        Boolean(tool) && typeof (tool as AnthropicTool).name === 'string',
    )
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    }));
}

function translateAnthropicToolChoice(toolChoice: unknown): unknown {
  if (toolChoice == null || typeof toolChoice !== 'object') return undefined;
  const type = (toolChoice as { type?: unknown }).type;
  if (type === 'auto') return 'auto';
  if (type === 'any') return 'required';
  if (type === 'none') return 'none';
  if (type === 'tool' && typeof (toolChoice as { name?: unknown }).name === 'string') {
    return { type: 'function', function: { name: (toolChoice as { name: string }).name } };
  }
  return undefined;
}

// Anthropic Messages request -> OpenAI chat.completions body. This is the
// ingress-side counterpart to `buildAnthropicRequest` in
// `transports/anthropic/request.ts` (which goes the other way, OpenAI ->
// Anthropic, for calling Anthropic as an *upstream*).
export function anthropicMessagesToChat(body: AnthropicMessagesRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const systemText = anthropicSystemToText(body.system);
  if (systemText) messages.push({ role: 'system', content: systemText });

  for (const message of body.messages ?? []) {
    if (message.role === 'assistant') pushAnthropicAssistantMessage(message, messages);
    else pushAnthropicUserMessage(message, messages);
  }

  const out: Record<string, unknown> = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };

  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length)
    out.stop = body.stop_sequences;
  // MUST forward the client's explicit thinking intent (both `enabled` with
  // its budget AND `disabled`) — see the `thinking` field doc comment above.
  // Without this, a project-configured reasoningEffort default could turn
  // extended thinking back ON against a client that explicitly disabled it,
  // or a client's own explicit thinking budget would be silently dropped in
  // favor of the default's effort level.
  if (body.thinking && typeof body.thinking === 'object') out.thinking = body.thinking;

  const tools = translateAnthropicTools(body.tools);
  if (tools) out.tools = tools;
  const toolChoice = translateAnthropicToolChoice(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  if (body.metadata && typeof body.metadata === 'object') out.metadata = body.metadata;

  return out;
}

function anthropicMessageId(openaiId: unknown): string {
  if (typeof openaiId === 'string' && openaiId) {
    return openaiId.startsWith('msg_') ? openaiId : `msg_${openaiId}`;
  }
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function mapFinishReason(finishReason: unknown): string | null {
  if (typeof finishReason !== 'string' || !finishReason) return null;
  return FINISH_REASON_TO_STOP_REASON[finishReason] ?? 'end_turn';
}

// OpenAI chat.completion JSON -> Anthropic Messages response.
export function chatJsonToAnthropicMessage(data: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = (choice?.message as Record<string, unknown>) ?? {};

  const content: Record<string, unknown>[] = [];
  const text = typeof message.content === 'string' ? message.content : '';
  if (text) content.push({ type: 'text', text });

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    const tc = toolCall as Record<string, unknown>;
    const fn = (tc.function as Record<string, unknown>) ?? {};
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: fn.name,
      input: safeParseJson(fn.arguments),
    });
  }

  const usage = (data.usage as Record<string, unknown>) ?? {};

  return {
    id: anthropicMessageId(data.id),
    type: 'message',
    role: 'assistant',
    model: data.model,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    },
  };
}

interface AnthropicSseState {
  messageId: string;
  model: string;
  messageStarted: boolean;
  finished: boolean;
  nextIndex: number;
  textIndex: number | null;
  openBlockIndex: number | null;
  toolIndexMap: Map<number, number>;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}

function sseFrame(encoder: TextEncoder, event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function ensureMessageStart(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicSseState,
): void {
  if (state.messageStarted) return;
  state.messageStarted = true;
  controller.enqueue(
    sseFrame(encoder, 'message_start', {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: state.promptTokens, output_tokens: 0 },
      },
    }),
  );
}

function closeOpenBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicSseState,
): void {
  if (state.openBlockIndex === null) return;
  controller.enqueue(
    sseFrame(encoder, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.openBlockIndex,
    }),
  );
  state.openBlockIndex = null;
}

function handleOpenAiChunk(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicSseState,
  chunk: Record<string, unknown>,
): void {
  if (typeof chunk.id === 'string' && chunk.id) state.messageId = anthropicMessageId(chunk.id);
  if (typeof chunk.model === 'string' && chunk.model) state.model = chunk.model;
  const usage = chunk.usage as Record<string, unknown> | undefined;
  if (usage) {
    if (typeof usage.prompt_tokens === 'number') state.promptTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === 'number')
      state.completionTokens = usage.completion_tokens;
  }

  ensureMessageStart(controller, encoder, state);

  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  if (!choice) return;
  const delta = (choice.delta as Record<string, unknown>) ?? {};

  if (typeof delta.content === 'string' && delta.content) {
    if (state.openBlockIndex !== null && state.openBlockIndex !== state.textIndex) {
      closeOpenBlock(controller, encoder, state);
    }
    if (state.textIndex === null) {
      state.textIndex = state.nextIndex++;
      controller.enqueue(
        sseFrame(encoder, 'content_block_start', {
          type: 'content_block_start',
          index: state.textIndex,
          content_block: { type: 'text', text: '' },
        }),
      );
      state.openBlockIndex = state.textIndex;
    }
    controller.enqueue(
      sseFrame(encoder, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.textIndex,
        delta: { type: 'text_delta', text: delta.content },
      }),
    );
  }

  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const rawToolCall of toolCalls) {
    const toolCall = rawToolCall as Record<string, unknown>;
    const openAiIndex = typeof toolCall.index === 'number' ? toolCall.index : 0;
    let anthropicIndex = state.toolIndexMap.get(openAiIndex);
    const fn = (toolCall.function as Record<string, unknown>) ?? {};
    if (anthropicIndex === undefined) {
      closeOpenBlock(controller, encoder, state);
      anthropicIndex = state.nextIndex++;
      state.toolIndexMap.set(openAiIndex, anthropicIndex);
      controller.enqueue(
        sseFrame(encoder, 'content_block_start', {
          type: 'content_block_start',
          index: anthropicIndex,
          content_block: {
            type: 'tool_use',
            id:
              typeof toolCall.id === 'string' && toolCall.id
                ? toolCall.id
                : `toolu_${anthropicIndex}`,
            name: typeof fn.name === 'string' ? fn.name : '',
            input: {},
          },
        }),
      );
      state.openBlockIndex = anthropicIndex;
    }
    if (typeof fn.arguments === 'string' && fn.arguments) {
      controller.enqueue(
        sseFrame(encoder, 'content_block_delta', {
          type: 'content_block_delta',
          index: anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: fn.arguments },
        }),
      );
    }
  }

  if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
    state.finishReason = choice.finish_reason;
  }
}

function finishAnthropicStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicSseState,
): void {
  if (state.finished) return;
  state.finished = true;
  ensureMessageStart(controller, encoder, state);
  closeOpenBlock(controller, encoder, state);
  controller.enqueue(
    sseFrame(encoder, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapFinishReason(state.finishReason) ?? 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: state.completionTokens },
    }),
  );
  controller.enqueue(sseFrame(encoder, 'message_stop', { type: 'message_stop' }));
  controller.close();
}

// OpenAI chat.completions SSE stream -> Anthropic Messages SSE stream. Keeps
// streaming truly streaming: each upstream chunk is translated and enqueued
// as it arrives, never buffered whole.
export function chatSseToAnthropicSse(
  openAiStream: ReadableStream<Uint8Array>,
  opts: { model?: string } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const state: AnthropicSseState = {
    messageId: anthropicMessageId(undefined),
    model: opts.model ?? '',
    messageStarted: false,
    finished: false,
    nextIndex: 0,
    textIndex: null,
    openBlockIndex: null,
    toolIndexMap: new Map(),
    finishReason: null,
    promptTokens: 0,
    completionTokens: 0,
  };

  let buffer = '';

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = openAiStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (
            let newlineAt = buffer.indexOf('\n');
            newlineAt >= 0;
            newlineAt = buffer.indexOf('\n')
          ) {
            const line = buffer.slice(0, newlineAt).replace(/\r$/, '');
            buffer = buffer.slice(newlineAt + 1);
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;
            if (dataStr === '[DONE]') {
              finishAnthropicStream(controller, encoder, state);
              return;
            }
            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(dataStr) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (chunk.error) {
              ensureMessageStart(controller, encoder, state);
              const err = chunk.error as Record<string, unknown>;
              controller.enqueue(
                sseFrame(encoder, 'error', {
                  type: 'error',
                  error: {
                    type: typeof err.type === 'string' ? err.type : 'api_error',
                    message: typeof err.message === 'string' ? err.message : 'upstream error',
                  },
                }),
              );
              continue;
            }
            handleOpenAiChunk(controller, encoder, state, chunk);
          }
        }
      } catch {
        // Upstream stream broke — finish with what we have rather than hang
        // the client forever without a message_stop.
      } finally {
        finishAnthropicStream(controller, encoder, state);
      }
    },
  });
}
