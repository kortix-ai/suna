// OpenAI Responses API ingress: translates the Responses API
// (`POST /responses`) request/response/SSE shapes to and from the gateway's
// internal representation, which is always the OpenAI chat.completions shape
// (the same one `handleChatCompletions` consumes and produces). Translation
// happens entirely around the pipeline — auth, billing, routing, failover,
// metering and trace all still run against the OpenAI-shaped body, exactly as
// they do for `/v1/llm/chat/completions` and `/v1/messages`.
//
// This exists because Codex CLI >=0.157 only speaks `wire_api = "responses"`
// (it 400s configuring `wire_api = "chat"`), so it must reach the gateway at
// `/responses`, not `/chat/completions`. `codex/*` models already route to
// the ChatGPT backend via the ai-sdk transport's `.responses()` call
// (transports/ai-sdk/model.ts) regardless of which ingress produced the
// internal chat.completions body — this ingress does not special-case codex
// at all, it only translates wire shapes.

export type ResponsesContentPart = Record<string, unknown> & { type: string };

export interface ResponsesInputItem {
  type?: string; // 'message' | 'function_call' | 'function_call_output' | 'reasoning' | undefined (bare message)
  role?: 'user' | 'assistant' | 'system' | 'developer';
  content?: string | ResponsesContentPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: string | ResponsesInputItem[];
  tools?: Record<string, unknown>[];
  tool_choice?: Record<string, unknown> | string;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  store?: boolean;
  stream?: boolean;
  include?: string[];
  metadata?: Record<string, unknown>;
  prompt_cache_key?: string;
  [key: string]: unknown;
}

function safeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function textFromContentParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is ResponsesContentPart =>
        Boolean(part) &&
        typeof part === 'object' &&
        ['input_text', 'output_text', 'text', 'refusal'].includes((part as ResponsesContentPart).type),
    )
    .map((part) => String((part as { text?: unknown }).text ?? ''))
    .join('');
}

function contentPartsToOpenAiParts(content: unknown): Record<string, unknown>[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Record<string, unknown>[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as ResponsesContentPart;
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
      parts.push({ type: 'text', text: (p as { text?: unknown }).text ?? '' });
    } else if (p.type === 'input_image') {
      const url = (p as { image_url?: unknown }).image_url;
      if (typeof url === 'string' && url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return parts;
}

function collapseTextIfSingle(parts: Record<string, unknown>[]): string | Record<string, unknown>[] {
  if (parts.length === 1 && parts[0].type === 'text') return String(parts[0].text ?? '');
  return parts;
}

// One Responses `input` array interleaves plain messages with function-call
// bookkeeping items (the Responses equivalent of Anthropic's tool_use /
// tool_result blocks, but flattened into sibling items rather than nested
// inside one message). Consecutive `function_call` items fold into a single
// OpenAI assistant message with multiple `tool_calls`, matching how a real
// upstream chat.completions turn is shaped.
function pushResponsesInputItem(item: ResponsesInputItem, out: Record<string, unknown>[]): void {
  const type = item.type ?? 'message';

  if (type === 'function_call') {
    const toolCall = {
      id: item.call_id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments ?? '{}' },
    };
    const last = out[out.length - 1];
    if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) {
      (last.tool_calls as unknown[]).push(toolCall);
    } else {
      out.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
    }
    return;
  }

  if (type === 'function_call_output') {
    const output = item.output;
    const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
    out.push({ role: 'tool', tool_call_id: item.call_id, content: text });
    return;
  }

  if (type === 'reasoning') {
    // Encrypted reasoning items round-trip through Codex's own state, not
    // through the internal chat.completions representation — chat.completions
    // has no field for them. Dropped here; see the module doc comment.
    return;
  }

  // Plain message item (`type: 'message'` or untyped).
  const role = item.role === 'developer' ? 'system' : (item.role ?? 'user');
  const parts = contentPartsToOpenAiParts(item.content);
  out.push({ role, content: collapseTextIfSingle(parts) });
}

function translateResponsesTools(tools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === 'object')
    .map((tool) => {
      // Responses tools are already flat ({type:'function', name, ...});
      // chat.completions nests the function fields under `function`.
      if (tool.type && tool.type !== 'function') return tool;
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      };
    });
}

function translateResponsesToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === 'string') return toolChoice; // 'auto' | 'none' | 'required' pass through verbatim
  if (toolChoice == null || typeof toolChoice !== 'object') return undefined;
  const type = (toolChoice as { type?: unknown }).type;
  if (type === 'function' && typeof (toolChoice as { name?: unknown }).name === 'string') {
    return { type: 'function', function: { name: (toolChoice as { name: string }).name } };
  }
  return undefined;
}

// Responses API request -> OpenAI chat.completions body.
export function responsesToChat(body: ResponsesRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });

  if (typeof body.input === 'string') {
    if (body.input) messages.push({ role: 'user', content: body.input });
  } else {
    for (const item of body.input ?? []) pushResponsesInputItem(item, messages);
  }

  const out: Record<string, unknown> = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };

  if (typeof body.max_output_tokens === 'number') out.max_tokens = body.max_output_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (typeof body.parallel_tool_calls === 'boolean') out.parallel_tool_calls = body.parallel_tool_calls;

  // Forward both the nested shape (`buildAiSdkArgs` reads `reasoning.effort`
  // first) and the flat `reasoning_effort` fallback other transports read.
  if (body.reasoning && typeof body.reasoning === 'object') {
    out.reasoning = body.reasoning;
    if (typeof body.reasoning.effort === 'string') out.reasoning_effort = body.reasoning.effort;
  }

  const tools = translateResponsesTools(body.tools);
  if (tools) out.tools = tools;
  const toolChoice = translateResponsesToolChoice(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  if (typeof body.prompt_cache_key === 'string') out.prompt_cache_key = body.prompt_cache_key;
  // `metadata`/`client_metadata` forwarded verbatim; the codex-specific
  // ai-sdk adapter already strips `metadata` before it reaches the ChatGPT
  // backend (buildProviderOptions, transports/ai-sdk/request.ts), so a
  // non-codex Responses-capable upstream is the only one that would see it.
  const metadata = body.metadata ?? (body.client_metadata as Record<string, unknown> | undefined);
  if (metadata && typeof metadata === 'object') out.metadata = metadata;

  return out;
}

function responsesId(prefix: string, openaiId: unknown): string {
  if (typeof openaiId === 'string' && openaiId) {
    return openaiId.startsWith(`${prefix}_`) ? openaiId : `${prefix}_${openaiId}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

const FINISH_REASON_TO_STATUS: Record<string, string> = {
  stop: 'completed',
  tool_calls: 'completed',
  length: 'incomplete',
  content_filter: 'completed',
};

interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

function responsesUsage(usage: Record<string, unknown> | undefined): ResponsesUsage {
  const input = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const output = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const total = typeof usage?.total_tokens === 'number' ? usage.total_tokens : input + output;
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

// OpenAI chat.completion JSON -> Responses API `response` object.
export function chatJsonToResponsesObject(data: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = (choice?.message as Record<string, unknown>) ?? {};

  const output: Record<string, unknown>[] = [];
  const text = typeof message.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  if (text) {
    output.push({
      type: 'message',
      id: responsesId('msg', undefined),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const toolCall of toolCalls) {
    const tc = toolCall as Record<string, unknown>;
    const fn = (tc.function as Record<string, unknown>) ?? {};
    output.push({
      type: 'function_call',
      id: responsesId('fc', tc.id),
      call_id: typeof tc.id === 'string' ? tc.id : responsesId('call', undefined),
      name: fn.name,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      status: 'completed',
    });
  }

  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
  const status = (finishReason && FINISH_REASON_TO_STATUS[finishReason]) || 'completed';
  const usage = responsesUsage(data.usage as Record<string, unknown> | undefined);

  return {
    id: responsesId('resp', data.id),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: data.model,
    output,
    output_text: text,
    usage,
  };
}

interface ResponsesSseState {
  responseId: string;
  model: string;
  createdSent: boolean;
  finished: boolean;
  nextOutputIndex: number;
  textItem: { outputIndex: number; itemId: string; text: string } | null;
  toolCalls: Map<number, { outputIndex: number; itemId: string; callId: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: ResponsesUsage;
}

function sseFrame(encoder: TextEncoder, event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function ensureCreated(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ResponsesSseState,
): void {
  if (state.createdSent) return;
  state.createdSent = true;
  const response = {
    id: state.responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model: state.model,
    output: [],
  };
  controller.enqueue(sseFrame(encoder, 'response.created', { type: 'response.created', response }));
  controller.enqueue(sseFrame(encoder, 'response.in_progress', { type: 'response.in_progress', response }));
}

function ensureTextItem(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ResponsesSseState,
): { outputIndex: number; itemId: string } {
  if (state.textItem) return state.textItem;
  const outputIndex = state.nextOutputIndex++;
  const itemId = responsesId('msg', undefined);
  state.textItem = { outputIndex, itemId, text: '' };
  controller.enqueue(
    sseFrame(encoder, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
    }),
  );
  controller.enqueue(
    sseFrame(encoder, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }),
  );
  return state.textItem;
}

function closeTextItem(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ResponsesSseState,
): void {
  if (!state.textItem) return;
  const { outputIndex, itemId, text } = state.textItem;
  controller.enqueue(
    sseFrame(encoder, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text,
    }),
  );
  controller.enqueue(
    sseFrame(encoder, 'response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    }),
  );
  controller.enqueue(
    sseFrame(encoder, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        type: 'message',
        id: itemId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    }),
  );
  state.textItem = null;
}

function handleOpenAiChunk(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ResponsesSseState,
  chunk: Record<string, unknown>,
): void {
  if (typeof chunk.id === 'string' && chunk.id) state.responseId = responsesId('resp', chunk.id);
  if (typeof chunk.model === 'string' && chunk.model) state.model = chunk.model;
  const usage = chunk.usage as Record<string, unknown> | undefined;
  if (usage) state.usage = responsesUsage(usage);

  ensureCreated(controller, encoder, state);

  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  if (!choice) return;
  const delta = (choice.delta as Record<string, unknown>) ?? {};

  if (typeof delta.content === 'string' && delta.content) {
    const item = ensureTextItem(controller, encoder, state);
    state.textItem!.text += delta.content;
    controller.enqueue(
      sseFrame(encoder, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: item.itemId,
        output_index: item.outputIndex,
        content_index: 0,
        delta: delta.content,
      }),
    );
  }

  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const rawToolCall of toolCalls) {
    const toolCall = rawToolCall as Record<string, unknown>;
    const openAiIndex = typeof toolCall.index === 'number' ? toolCall.index : 0;
    const fn = (toolCall.function as Record<string, unknown>) ?? {};
    let pending = state.toolCalls.get(openAiIndex);
    if (!pending) {
      // A tool call starting mid-stream closes any open text block first, so
      // Codex CLI (which renders items strictly by output_index order) never
      // sees a text delta interleaved after a function call has started.
      closeTextItem(controller, encoder, state);
      const outputIndex = state.nextOutputIndex++;
      const itemId = responsesId('fc', undefined);
      const callId = typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : responsesId('call', undefined);
      pending = { outputIndex, itemId, callId, name: '', arguments: '' };
      state.toolCalls.set(openAiIndex, pending);
      controller.enqueue(
        sseFrame(encoder, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { type: 'function_call', id: itemId, call_id: callId, name: '', arguments: '', status: 'in_progress' },
        }),
      );
    }
    if (typeof toolCall.id === 'string' && toolCall.id) pending.callId = toolCall.id;
    if (typeof fn.name === 'string' && fn.name) pending.name += fn.name;
    if (typeof fn.arguments === 'string' && fn.arguments) {
      pending.arguments += fn.arguments;
      controller.enqueue(
        sseFrame(encoder, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: pending.itemId,
          output_index: pending.outputIndex,
          delta: fn.arguments,
        }),
      );
    }
  }

  if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
    state.finishReason = choice.finish_reason;
  }
}

function finishResponsesStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ResponsesSseState,
): void {
  if (state.finished) return;
  state.finished = true;
  ensureCreated(controller, encoder, state);
  closeTextItem(controller, encoder, state);

  const outputItems: Record<string, unknown>[] = [];
  for (const [, tool] of [...state.toolCalls].sort(([a], [b]) => a - b)) {
    controller.enqueue(
      sseFrame(encoder, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        arguments: tool.arguments,
      }),
    );
    const item = {
      type: 'function_call',
      id: tool.itemId,
      call_id: tool.callId,
      name: tool.name,
      arguments: tool.arguments,
      status: 'completed',
    };
    controller.enqueue(
      sseFrame(encoder, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: tool.outputIndex,
        item,
      }),
    );
    outputItems.push(item);
  }

  const status = (state.finishReason && FINISH_REASON_TO_STATUS[state.finishReason]) || 'completed';
  const response = {
    id: state.responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: state.model,
    output: outputItems,
    usage: state.usage,
  };
  controller.enqueue(sseFrame(encoder, 'response.completed', { type: 'response.completed', response }));
  controller.close();
}

// OpenAI chat.completions SSE stream -> Responses API SSE stream.
export function chatSseToResponsesSse(
  openAiStream: ReadableStream<Uint8Array>,
  opts: { model?: string } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const state: ResponsesSseState = {
    responseId: responsesId('resp', undefined),
    model: opts.model ?? '',
    createdSent: false,
    finished: false,
    nextOutputIndex: 0,
    textItem: null,
    toolCalls: new Map(),
    finishReason: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  let buffer = '';
  const reader = openAiStream.getReader();
  let cancelled = false;
  let resume: (() => void) | null = null;
  const wake = (): void => {
    const resolve = resume;
    resume = null;
    resolve?.();
  };

  const produce = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    const awaitDemand = async (): Promise<void> => {
      if (cancelled) return;
      if ((controller.desiredSize ?? 1) > 0) return;
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
    };
    try {
      while (true) {
        await awaitDemand();
        if (cancelled) break;
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
            finishResponsesStream(controller, encoder, state);
            return;
          }
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(dataStr) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (chunk.error) {
            ensureCreated(controller, encoder, state);
            const err = chunk.error as Record<string, unknown>;
            controller.enqueue(
              sseFrame(encoder, 'error', {
                type: 'error',
                message: typeof err.message === 'string' ? err.message : 'upstream error',
              }),
            );
            continue;
          }
          handleOpenAiChunk(controller, encoder, state, chunk);
        }
      }
    } catch {
      // The upstream broke before [DONE]. Report a failed turn so Codex CLI
      // retries the request instead of treating a truncated answer as done.
      if (!cancelled && !state.finished) {
        state.finished = true;
        ensureCreated(controller, encoder, state);
        closeTextItem(controller, encoder, state);
        controller.enqueue(
          sseFrame(encoder, 'error', {
            type: 'error',
            message: 'Upstream stream ended before the response completed',
          }),
        );
        controller.close();
      }
    } finally {
      if (!cancelled) finishResponsesStream(controller, encoder, state);
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void produce(controller);
    },
    pull() {
      wake();
    },
    async cancel(reason) {
      cancelled = true;
      wake();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

// exported for tests that need to parse a tool call's arguments as JSON.
export { safeParseJson as parseResponsesToolArguments };
