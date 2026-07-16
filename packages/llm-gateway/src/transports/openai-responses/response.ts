type Json = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function mapUsage(usage: unknown): Json | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Json;
  const inputTokens = Number(u.input_tokens ?? 0);
  const outputTokens = Number(u.output_tokens ?? 0);
  const cached = Number((u.input_tokens_details as Json | undefined)?.cached_tokens ?? 0);
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: Number(u.total_tokens ?? inputTokens + outputTokens),
    prompt_tokens_details: { cached_tokens: cached },
  };
}

function collectFromOutput(output: unknown[]): { text: string; toolCalls: Json[] } {
  let text = '';
  const toolCalls: Json[] = [];
  for (const raw of output) {
    const item = raw as Json;
    if (item.type === 'message') {
      for (const part of asArray(item.content)) {
        const p = part as Json;
        if (p.type === 'output_text' && typeof p.text === 'string') text += p.text;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: 'function',
        function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '' },
      });
    }
  }
  return { text, toolCalls };
}

export function responsesJsonToChat(data: Json): Json {
  const response = (data.response as Json | undefined) ?? data;
  const { text, toolCalls } = collectFromOutput(asArray(response.output));
  const message: Json = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: response.id ?? 'chatcmpl',
    object: 'chat.completion',
    created: nowSeconds(),
    model: response.model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: mapUsage(response.usage) ?? undefined,
  };
}

function parseFrame(frame: string): Json | null {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (!dataLines.length) return null;
  const payload = dataLines.join('');
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as Json;
  } catch {
    return null;
  }
}

interface StreamState {
  id: string;
  model: unknown;
  toolIndex: Map<string, number>;
  nextToolIndex: number;
  sawToolCall: boolean;
  sawText: boolean;
}

// Pull a usable message/code/type out of an upstream Responses error object
// (`response.error` on a `response.failed` event, or a top-level `error` frame).
function extractError(err: unknown): { message?: string; code?: string; type?: string } {
  if (!err || typeof err !== 'object') return {};
  const e = err as Json;
  return {
    message: typeof e.message === 'string' ? e.message : undefined,
    code: typeof e.code === 'string' ? e.code : undefined,
    type: typeof e.type === 'string' ? e.type : undefined,
  };
}

// An OpenAI-shaped error frame. The `@ai-sdk/openai-compatible` provider opencode
// runs treats a streamed `{ error: { message, ... } }` chunk as a terminal error
// (surfaced as a retry banner), NOT a clean stop — so a failed/empty upstream turn
// no longer masquerades as the assistant choosing to say nothing.
function errorChunk(message: string, code: string, type = 'upstream_error'): Json {
  return { error: { message, type, code } };
}

function chunk(state: StreamState, delta: Json, finishReason: string | null, usage?: Json): Json {
  const out: Json = {
    id: state.id || 'chatcmpl',
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) out.usage = usage;
  return out;
}

function eventToChunks(event: Json, state: StreamState): Json[] {
  switch (event.type) {
    case 'response.created': {
      const response = event.response as Json | undefined;
      if (response?.id) state.id = String(response.id);
      if (response?.model) state.model = response.model;
      return [chunk(state, { role: 'assistant', content: '' }, null)];
    }
    case 'response.output_text.delta': {
      if (typeof event.delta !== 'string') return [];
      state.sawText = true;
      return [chunk(state, { content: event.delta }, null)];
    }
    case 'response.output_item.added': {
      const item = event.item as Json | undefined;
      if (item?.type !== 'function_call') return [];
      const key = String(item.id ?? item.call_id ?? state.nextToolIndex);
      const index = state.nextToolIndex++;
      state.toolIndex.set(key, index);
      state.sawToolCall = true;
      return [
        chunk(state, {
          tool_calls: [{ index, id: item.call_id ?? item.id, type: 'function', function: { name: item.name, arguments: '' } }],
        }, null),
      ];
    }
    case 'response.function_call_arguments.delta': {
      if (typeof event.delta !== 'string') return [];
      const key = String(event.item_id ?? '');
      const index = state.toolIndex.get(key) ?? 0;
      return [chunk(state, { tool_calls: [{ index, function: { arguments: event.delta } }] }, null)];
    }
    case 'response.completed': {
      const response = event.response as Json | undefined;
      if (response?.model) state.model = response.model;
      const usage = mapUsage(response?.usage);
      return [chunk(state, {}, state.sawToolCall ? 'tool_calls' : 'stop', usage)];
    }
    case 'response.failed': {
      // Upstream gave up mid-stream (HTTP stays 200, so retry/failover upstream
      // never sees it). Surface the error instead of laundering it into `stop`.
      const response = event.response as Json | undefined;
      const { message, code, type } = extractError(response?.error);
      return [errorChunk(message ?? 'Upstream model failed to generate a response', code ?? 'upstream_failed', type ?? 'upstream_error')];
    }
    case 'error': {
      // Top-level Responses API error frame.
      const { message, code, type } = extractError(event);
      return [errorChunk(message ?? 'Upstream stream error', code ?? 'upstream_error', type ?? 'upstream_error')];
    }
    case 'response.incomplete': {
      const response = event.response as Json | undefined;
      const usage = mapUsage(response?.usage);
      const reason = (response?.incomplete_details as Json | undefined)?.reason;
      // Output already streamed → honest truncation (`length`/`content_filter`),
      // keeping usage so the partial turn is billed and the client knows it was cut off.
      if (state.sawText || state.sawToolCall) {
        const finish = reason === 'content_filter' ? 'content_filter' : 'length';
        return [chunk(state, {}, finish, usage)];
      }
      // No output at all (e.g. a reasoning model that spent its whole budget before
      // emitting anything) → an error, not a clean stop, so the agent doesn't die silently.
      const detail = typeof reason === 'string' ? ` (${reason})` : '';
      return [errorChunk(`Model returned an incomplete response with no output${detail}`, typeof reason === 'string' ? reason : 'incomplete', 'incomplete')];
    }
    default:
      return [];
  }
}

function translateStream(upstream: Response): Response {
  const body = upstream.body;
  if (!body) return upstream;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: StreamState = { id: '', model: undefined, toolIndex: new Map(), nextToolIndex: 0, sawToolCall: false, sawText: false };
  let buffer = '';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      const send = (obj: Json) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = parseFrame(frame);
            if (event) for (const out of eventToChunks(event, state)) send(out);
            boundary = buffer.indexOf('\n\n');
          }
        }
        const tail = parseFrame(buffer);
        if (tail) for (const out of eventToChunks(tail, state)) send(out);
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
}

async function collectStreamAsChat(upstream: Response): Promise<Response> {
  const translated = translateStream(upstream);
  const text = await translated.text();
  const chunks = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== '[DONE]')
    .flatMap((payload) => {
      try {
        return [JSON.parse(payload) as Json];
      } catch {
        return [];
      }
    });

  let id: unknown = 'chatcmpl';
  let model: unknown;
  let content = '';
  let finishReason: unknown = 'stop';
  let usage: unknown;
  let error: unknown;
  const toolCalls = new Map<number, Json>();

  for (const chunk of chunks) {
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.error) error = chunk.error;
    const choice = asArray(chunk.choices)[0] as Json | undefined;
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta as Json | undefined;
    if (typeof delta?.content === 'string') content += delta.content;
    for (const rawTool of asArray(delta?.tool_calls)) {
      const tool = rawTool as Json;
      const index = Number(tool.index ?? 0);
      const current = toolCalls.get(index) ?? {
        id: tool.id,
        type: 'function',
        function: { name: undefined, arguments: '' },
      };
      if (tool.id) current.id = tool.id;
      const currentFunction = current.function as Json;
      const nextFunction = tool.function as Json | undefined;
      if (nextFunction?.name) currentFunction.name = nextFunction.name;
      if (typeof nextFunction?.arguments === 'string') {
        currentFunction.arguments = `${currentFunction.arguments ?? ''}${nextFunction.arguments}`;
      }
      toolCalls.set(index, current);
    }
  }

  if (error) {
    return new Response(JSON.stringify({ error }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const message: Json = { role: 'assistant', content: content || null };
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tool]) => tool);
  return new Response(JSON.stringify({
    id,
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function translateResponsesResponse(
  response: Response,
  ctx: { streaming: boolean; descriptor?: { provider: string } },
): Promise<Response> {
  if (ctx.streaming) return translateStream(response);
  if (
    ctx.descriptor?.provider === 'openai-codex' ||
    response.headers.get('content-type')?.includes('text/event-stream')
  ) {
    return collectStreamAsChat(response);
  }
  const data = (await response.json()) as Json;
  return new Response(JSON.stringify(responsesJsonToChat(data)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
