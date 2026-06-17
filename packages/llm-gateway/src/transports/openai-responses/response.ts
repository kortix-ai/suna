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
    case 'response.failed':
    case 'response.incomplete': {
      return [chunk(state, {}, 'stop')];
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
  const state: StreamState = { id: '', model: undefined, toolIndex: new Map(), nextToolIndex: 0, sawToolCall: false };
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

export async function translateResponsesResponse(
  response: Response,
  ctx: { streaming: boolean },
): Promise<Response> {
  if (ctx.streaming) return translateStream(response);
  const data = (await response.json()) as Json;
  return new Response(JSON.stringify(responsesJsonToChat(data)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
