// Anthropic-on-Bedrock payload mapping for managed Claude models.
//
// Carved out of the heavy LLM gateway (packages/llm-gateway/src/transports/
// {anthropic,bedrock}/*) per the llm-native-refactor spec §4: the slim managed
// endpoint owns its OWN copy of the pure request/response shaping so it stays
// self-contained when the gateway package is deleted (Phase 4). NO failover,
// breaker, resilience, or transport registry — just the deterministic payload
// translation: OpenAI chat-completions <-> Anthropic InvokeModel.

const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';
const DEFAULT_MAX_TOKENS = 4096;

// ─── OpenAI chat-completions → Anthropic messages payload ───────────────────

function safeParse(value: unknown): unknown {
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
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as any).text ?? '') : ''))
      .join('');
  }
  return '';
}

function translateUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOf(content);
  return content.map((part: any) => {
    if (part?.type === 'text') return { type: 'text', text: part.text };
    if (part?.type === 'image_url') {
      const url: string = part.image_url?.url ?? '';
      if (url.startsWith('data:')) {
        const comma = url.indexOf(',');
        const meta = url.slice(5, comma);
        const data = url.slice(comma + 1);
        const mediaType = meta.split(';')[0] || 'image/png';
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      }
      return { type: 'image', source: { type: 'url', url } };
    }
    return part;
  });
}

function translateMessages(messages: any[]): { system?: string; messages: any[] } {
  const systemParts: string[] = [];
  const out: any[] = [];
  for (const m of messages ?? []) {
    if (m.role === 'system') {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const content: any[] = [];
      const text = textOf(m.content);
      if (text) content.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: safeParse(tc.function?.arguments) });
      }
      out.push({ role: 'assistant', content: content.length ? content : '' });
      continue;
    }
    out.push({ role: 'user', content: translateUserContent(m.content) });
  }
  return { system: systemParts.filter(Boolean).join('\n\n') || undefined, messages: out };
}

function translateTools(tools: any[]): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter((t) => t?.function?.name)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
}

function translateToolChoice(tc: unknown): unknown {
  if (tc === 'required') return { type: 'any' };
  if (tc === 'auto' || tc === 'none' || tc == null) return undefined;
  if (typeof tc === 'object' && (tc as any).function?.name) return { type: 'tool', name: (tc as any).function.name };
  return undefined;
}

const EPHEMERAL = { type: 'ephemeral' } as const;

function cacheTailBlock(message: any): void {
  if (!message) return;
  const content = message.content;
  if (typeof content === 'string') {
    if (content) message.content = [{ type: 'text', text: content, cache_control: EPHEMERAL }];
    return;
  }
  if (Array.isArray(content) && content.length) {
    const last = content[content.length - 1];
    if (last && typeof last === 'object') last.cache_control = EPHEMERAL;
  }
}

function applyPromptCaching(payload: Record<string, any>): void {
  if (typeof payload.system === 'string' && payload.system) {
    payload.system = [{ type: 'text', text: payload.system, cache_control: EPHEMERAL }];
  }
  if (Array.isArray(payload.tools) && payload.tools.length) {
    payload.tools[payload.tools.length - 1].cache_control = EPHEMERAL;
  }
  if (Array.isArray(payload.messages) && payload.messages.length) {
    cacheTailBlock(payload.messages[payload.messages.length - 1]);
  }
}

/** Build the Anthropic-shaped core payload (no `model`/`stream` — those are the
 *  Bedrock URL/action) from an OpenAI chat-completions body. */
export function buildAnthropicCorePayload(body: Record<string, any>): Record<string, unknown> {
  const { system, messages } = translateMessages(body.messages ?? []);

  const payload: Record<string, unknown> = {
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system) payload.system = system;
  if (body.temperature != null) payload.temperature = body.temperature;
  if (body.top_p != null) payload.top_p = body.top_p;
  if (body.stop != null) payload.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  const tools = translateTools(body.tools);
  if (tools) payload.tools = tools;
  const toolChoice = translateToolChoice(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;

  applyPromptCaching(payload);
  return payload;
}

/** The full InvokeModel body: `anthropic_version` + the translated core payload. */
export function buildBedrockInvokePayload(body: Record<string, any>): Record<string, unknown> {
  return {
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    ...buildAnthropicCorePayload(body),
  };
}

// ─── Anthropic response → OpenAI chat-completions ───────────────────────────

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

function translateAnthropicResponse(response: Response, ctx: { streaming: boolean }): Response | Promise<Response> {
  return ctx.streaming ? translateStreaming(response) : translateNonStreaming(response);
}

// ─── Bedrock AWS event-stream framing → Anthropic SSE ───────────────────────

function readU32(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bedrockEventStreamToSse(response: Response): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = response.body!.getReader();
      let buf: Uint8Array = new Uint8Array(0);
      let pos = 0;
      try {
        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          buf = buf.length === pos ? value : concat(buf.subarray(pos), value);
          pos = 0;

          while (buf.length - pos >= 12) {
            const total = readU32(buf, pos);
            if (total < 16) break outer;
            if (buf.length - pos < total) break;
            const headersLen = readU32(buf, pos + 4);
            const payload = buf.subarray(pos + 12 + headersLen, pos + total - 4);
            pos += total;

            let frame: { bytes?: string; message?: string };
            try {
              frame = JSON.parse(decoder.decode(payload));
            } catch {
              continue;
            }
            if (typeof frame.bytes === 'string') {
              const eventJson = decoder.decode(base64ToBytes(frame.bytes));
              controller.enqueue(encoder.encode(`data: ${eventJson}\n\n`));
            } else {
              console.warn('[bedrock] event-stream error frame:', frame.message ?? JSON.stringify(frame));
            }
          }
        }
      } catch {
        // upstream stream broke; close with what was relayed
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Translate a raw Bedrock InvokeModel response into an OpenAI chat-completions
 *  response (streaming → SSE chunks, non-streaming → JSON). */
export function translateBedrockResponse(
  response: Response,
  ctx: { streaming: boolean },
): Response | Promise<Response> {
  if (ctx.streaming) {
    if (!response.ok || !response.body) return translateAnthropicResponse(response, { streaming: false });
    return translateAnthropicResponse(bedrockEventStreamToSse(response), { streaming: true });
  }
  return translateAnthropicResponse(response, { streaming: false });
}
