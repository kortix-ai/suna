// Bedrock Converse → OpenAI chat-completions translation.
//
// converse-stream returns an AWS event-stream (binary framing) where each
// message carries its event name in a `:event-type` header and the payload is
// the event JSON directly (unlike invoke-with-response-stream, which base64-wraps
// the payload in a `bytes` field). We parse the framing, read the header, and
// emit OpenAI `chat.completion.chunk` SSE.

const FINISH_REASON: Record<string, string> = {
  end_turn: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  stop_sequence: 'stop',
  content_filtered: 'stop',
  guardrail_intervened: 'stop',
};

function readU32(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Extract the `:event-type` value from an AWS event-stream headers block.
function eventTypeOf(headers: Uint8Array, dec: TextDecoder): string {
  let p = 0;
  while (p + 1 < headers.length) {
    const nameLen = headers[p];
    p += 1;
    if (p + nameLen > headers.length) break;
    const name = dec.decode(headers.subarray(p, p + nameLen));
    p += nameLen;
    const type = headers[p];
    p += 1;
    let valLen = 0;
    switch (type) {
      case 0:
      case 1:
        valLen = 0;
        break; // bool
      case 2:
        valLen = 1;
        break; // byte
      case 3:
        valLen = 2;
        break; // short
      case 4:
        valLen = 4;
        break; // int
      case 5:
        valLen = 8;
        break; // long
      case 6:
      case 7: {
        // bytes / string — 2-byte length prefix
        valLen = (headers[p] << 8) | headers[p + 1];
        p += 2;
        break;
      }
      case 8:
        valLen = 8;
        break; // timestamp
      case 9:
        valLen = 16;
        break; // uuid
      default:
        return ''; // unknown type — can't safely advance
    }
    const val = headers.subarray(p, p + valLen);
    p += valLen;
    if (name === ':event-type') return dec.decode(val);
  }
  return '';
}

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
        error: { message: data?.message ?? data?.Message ?? 'bedrock converse error', type: 'upstream_error' },
      }),
      { status: response.status || 502, headers: { 'content-type': 'application/json' } },
    );
  }
  const blocks = Array.isArray(data.output?.message?.content) ? data.output.message.content : [];
  let text = '';
  const toolCalls: any[] = [];
  for (const block of blocks) {
    if (typeof block?.text === 'string') text += block.text;
    else if (block?.toolUse) {
      toolCalls.push({
        id: block.toolUse.toolUseId,
        type: 'function',
        function: { name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input ?? {}) },
      });
    }
  }
  const message: Record<string, unknown> = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const inputTokens = data.usage?.inputTokens ?? 0;
  const outputTokens = data.usage?.outputTokens ?? 0;
  const cachedTokens = data.usage?.cacheReadInputTokens ?? 0;
  const out = {
    id: chunkId(),
    object: 'chat.completion',
    created: nowSec(),
    model: '',
    choices: [{ index: 0, message, finish_reason: FINISH_REASON[data.stopReason] ?? 'stop' }],
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
  const id = chunkId();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let cachedTokens = 0;
  let finishReason: string | null = null;
  // contentBlockIndex → tool_calls index (only set for toolUse blocks).
  const blockToTool = new Map<number, number>();
  let toolIndex = -1;
  let started = false;
  let finalized = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (delta: unknown, finish: string | null) => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: '', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          ),
        );
      };
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: '',
              choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? 'stop' }],
              usage: {
                ...usage,
                total_tokens: usage.prompt_tokens + usage.completion_tokens,
                ...(cachedTokens ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
              },
            })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      };

      const reader = response.body!.getReader();
      let buf: Uint8Array = new Uint8Array(0);
      let pos = 0;
      try {
        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          buf = pos === 0 ? value : concat(buf.subarray(pos), value);
          pos = 0;
          while (buf.length - pos >= 12) {
            const total = readU32(buf, pos);
            if (total < 16) break outer; // desynced — can't realign
            if (buf.length - pos < total) break; // wait for the rest of the frame
            const headersLen = readU32(buf, pos + 4);
            const headers = buf.subarray(pos + 12, pos + 12 + headersLen);
            const payloadBytes = buf.subarray(pos + 12 + headersLen, pos + total - 4);
            pos += total;

            const evtType = eventTypeOf(headers, decoder);
            let evt: any;
            try {
              evt = JSON.parse(decoder.decode(payloadBytes));
            } catch {
              continue;
            }

            if (evtType === 'messageStart') {
              if (!started) {
                started = true;
                emit({ role: 'assistant', content: '' }, null);
              }
            } else if (evtType === 'contentBlockStart') {
              const tu = evt.start?.toolUse;
              if (tu) {
                toolIndex += 1;
                blockToTool.set(evt.contentBlockIndex, toolIndex);
                emit({ tool_calls: [{ index: toolIndex, id: tu.toolUseId, type: 'function', function: { name: tu.name, arguments: '' } }] }, null);
              }
            } else if (evtType === 'contentBlockDelta') {
              const d = evt.delta;
              if (typeof d?.text === 'string') {
                emit({ content: d.text }, null);
              } else if (d?.toolUse?.input != null) {
                const ti = blockToTool.get(evt.contentBlockIndex) ?? 0;
                emit({ tool_calls: [{ index: ti, function: { arguments: String(d.toolUse.input) } }] }, null);
              }
            } else if (evtType === 'messageStop') {
              finishReason = FINISH_REASON[evt.stopReason] ?? 'stop';
            } else if (evtType === 'metadata') {
              usage.prompt_tokens = evt.usage?.inputTokens ?? usage.prompt_tokens;
              usage.completion_tokens = evt.usage?.outputTokens ?? usage.completion_tokens;
              cachedTokens = evt.usage?.cacheReadInputTokens ?? cachedTokens;
            } else if (evtType.endsWith('Exception') || evt?.message) {
              // throttling / model stream / validation error — surface it.
              console.warn('[bedrock-converse] stream error frame:', evtType, evt?.message ?? '');
            }
          }
        }
      } catch {
        // upstream stream broke; finalize with what we have
      } finally {
        if (started) finalize();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
}

export function translateBedrockConverseResponse(
  response: Response,
  ctx: { streaming: boolean },
): Response | Promise<Response> {
  return ctx.streaming ? translateStreaming(response) : translateNonStreaming(response);
}
