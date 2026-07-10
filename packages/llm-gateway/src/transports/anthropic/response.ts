const FINISH_REASON: Record<string, string> = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
};

function chunkId(): string {
  return 'chatcmpl-' + Math.random().toString(36).slice(2);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function translateNonStreaming(response: Response): Promise<Response> {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    return new Response(
      JSON.stringify({
        error: {
          message: data?.error?.message ?? 'anthropic upstream error',
          type: data?.error?.type ?? 'upstream_error',
        },
      }),
      { status: response.status || 502, headers: { 'content-type': 'application/json' } },
    );
  }

  const blocks = Array.isArray(data.content) ? data.content : [];
  let text = '';
  const toolCalls: any[] = [];
  for (const block of blocks) {
    if (block?.type === 'text') text += block.text ?? '';
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const cachedTokens = data.usage?.cache_read_input_tokens ?? 0;
  const inputTokens =
    (data.usage?.input_tokens ?? 0) + cachedTokens + (data.usage?.cache_creation_input_tokens ?? 0);
  const outputTokens = data.usage?.output_tokens ?? 0;
  const out = {
    id: data.id ?? chunkId(),
    object: 'chat.completion',
    created: nowSec(),
    model: data.model,
    choices: [{ index: 0, message, finish_reason: FINISH_REASON[data.stop_reason] ?? 'stop' }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cachedTokens ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
    },
  };
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
}

function translateStreaming(response: Response): Response {
  if (!response.ok || !response.body) return translateNonStreaming(response) as unknown as Response;

  const created = nowSec();
  let id = chunkId();
  let model = '';
  let toolIndex = -1;
  const blockToTool = new Map<number, number>();
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let cachedTokens = 0;
  let finishReason: string | null = null;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';

  const emit = (controller: ReadableStreamDefaultController, delta: unknown, finish: string | null) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
              continue;
            }
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;
            let evt: any;
            try {
              evt = JSON.parse(dataStr);
            } catch {
              continue;
            }
            const t = eventType || evt.type;
            eventType = '';

            if (t === 'message_start') {
              id = evt.message?.id ?? id;
              model = evt.message?.model ?? model;
              const mu = evt.message?.usage ?? {};
              cachedTokens = mu.cache_read_input_tokens ?? 0;
              usage.prompt_tokens =
                (mu.input_tokens ?? 0) + cachedTokens + (mu.cache_creation_input_tokens ?? 0);
              emit(controller, { role: 'assistant', content: '' }, null);
            } else if (t === 'content_block_start') {
              const block = evt.content_block;
              if (block?.type === 'tool_use') {
                toolIndex += 1;
                blockToTool.set(evt.index, toolIndex);
                emit(
                  controller,
                  { tool_calls: [{ index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] },
                  null,
                );
              }
            } else if (t === 'content_block_delta') {
              const d = evt.delta;
              if (d?.type === 'text_delta') {
                emit(controller, { content: d.text ?? '' }, null);
              } else if (d?.type === 'input_json_delta') {
                const ti = blockToTool.get(evt.index) ?? 0;
                emit(controller, { tool_calls: [{ index: ti, function: { arguments: d.partial_json ?? '' } }] }, null);
              }
            } else if (t === 'message_delta') {
              if (evt.delta?.stop_reason) finishReason = FINISH_REASON[evt.delta.stop_reason] ?? 'stop';
              if (evt.usage?.output_tokens != null) usage.completion_tokens = evt.usage.output_tokens;
            } else if (t === 'error') {
              // Anthropic reports a mid-flight failure (overloaded, request too
              // large, etc.) as an `error` event on an otherwise-200 stream. Emit
              // it as an OpenAI-shaped error frame — matching the openai-responses
              // transport — so the probe/relay surface the real cause instead of
              // laundering it into a generic empty "stop".
              const err = evt.error ?? {};
              const errChunk = {
                error: {
                  message: typeof err.message === 'string' ? err.message : 'anthropic upstream error',
                  type: typeof err.type === 'string' ? err.type : 'upstream_error',
                  code: typeof err.type === 'string' ? err.type : 'upstream_error',
                },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
            } else if (t === 'message_stop') {
              const finalChunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? 'stop' }],
                usage: {
                  ...usage,
                  total_tokens: usage.prompt_tokens + usage.completion_tokens,
                  ...(cachedTokens ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
                },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            }
          }
        }
      } catch {
        // upstream stream broke; close what we have
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
}

export function translateAnthropicResponse(
  response: Response,
  ctx: { streaming: boolean },
): Response | Promise<Response> {
  return ctx.streaming ? translateStreaming(response) : translateNonStreaming(response);
}
