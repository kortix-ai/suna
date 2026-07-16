import { describe, expect, test } from 'bun:test';

import { bedrockEventStreamToSse, translateBedrockResponse } from './response';

// ---- AWS event-stream binary frame test helpers -----------------------------
//
// Frame layout: [total:u32][headers-len:u32][prelude-crc:u32][headers][payload][message-crc:u32]
// CRCs are never validated by the parser under test, so placeholder zero
// bytes are fine here.

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function concatAll(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function encodeStringHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const valueBytes = new TextEncoder().encode(value);
  const out = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let o = 0;
  out[o++] = nameBytes.length;
  out.set(nameBytes, o);
  o += nameBytes.length;
  out[o++] = 7; // header value type: string
  out[o++] = (valueBytes.length >> 8) & 0xff;
  out[o++] = valueBytes.length & 0xff;
  out.set(valueBytes, o);
  return out;
}

function encodeFrame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const headerBytes = concatAll(...Object.entries(headers).map(([k, v]) => encodeStringHeader(k, v)));
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const headersLen = headerBytes.length;
  const total = 4 + 4 + 4 + headersLen + payloadBytes.length + 4;
  return concatAll(u32(total), u32(headersLen), u32(0), headerBytes, payloadBytes, u32(0));
}

function chunkFrame(anthropicEvent: unknown): Uint8Array {
  const bytes = btoa(JSON.stringify(anthropicEvent));
  return encodeFrame({ ':message-type': 'event', ':event-type': 'chunk' }, { bytes });
}

function exceptionFrame(exceptionType: string, message: string): Uint8Array {
  return encodeFrame(
    { ':message-type': 'exception', ':exception-type': exceptionType },
    { message },
  );
}

function streamResponse(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
    { status: 200 },
  );
}

async function collectSse(response: Response): Promise<string> {
  return new Response(response.body).text();
}

describe('bedrockEventStreamToSse', () => {
  test('reassembles a normal multi-frame stream into `data:` SSE lines', async () => {
    const upstream = streamResponse([
      concatAll(
        chunkFrame({ type: 'message_start', message: { id: 'm1', model: 'x', usage: { input_tokens: 1 } } }),
        chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
      ),
    ]);
    const sse = await collectSse(bedrockEventStreamToSse(upstream));
    const dataLines = sse
      .split('\n\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5).trim()));
    expect(dataLines).toHaveLength(2);
    expect(dataLines[0].type).toBe('message_start');
    expect(dataLines[1].type).toBe('content_block_delta');
    expect(dataLines[1].delta.text).toBe('hi');
  });

  test('reassembles a frame split across two chunk reads (partial-frame carryover)', async () => {
    const frame = chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'split-ok' } });
    const splitAt = Math.floor(frame.length / 2);
    const upstream = streamResponse([frame.subarray(0, splitAt), frame.subarray(splitAt)]);
    const sse = await collectSse(bedrockEventStreamToSse(upstream));
    expect(sse).toContain('split-ok');
    const dataLine = sse.split('\n\n').find((l) => l.startsWith('data:'))!;
    const parsed = JSON.parse(dataLine.slice(5).trim());
    expect(parsed.delta.text).toBe('split-ok');
  });

  test('surfaces an exception/error frame as a client-facing error SSE event, not just a console.warn', async () => {
    const upstream = streamResponse([
      concatAll(
        chunkFrame({ type: 'message_start', message: { id: 'm1', model: 'x', usage: { input_tokens: 1 } } }),
        exceptionFrame('ThrottlingException', 'Too many requests, please wait and try again.'),
      ),
    ]);
    const sse = await collectSse(bedrockEventStreamToSse(upstream));
    expect(sse).toContain('event: error');
    const frames = sse.split('\n\n').filter(Boolean);
    const errorFrameText = frames.find((f) => f.includes('event: error'))!;
    const dataLine = errorFrameText.split('\n').find((l) => l.startsWith('data:'))!;
    const parsed = JSON.parse(dataLine.slice(5).trim());
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('ThrottlingException');
    expect(parsed.error.message).toContain('Too many requests');
  });

  test('a desynced/undersized frame terminates the stream cleanly instead of hanging or spinning', async () => {
    // total length below the 16-byte minimum frame size => desync.
    const garbage = concatAll(u32(4), new Uint8Array([1, 2, 3, 4]));
    const upstream = streamResponse([garbage]);
    const sse = await Promise.race([
      collectSse(bedrockEventStreamToSse(upstream)),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('hung')), 2000)),
    ]);
    // No data frames emitted, and the call resolved (didn't hang / throw).
    expect(sse).not.toContain('data:');
  });

  test('an exception frame with an unparsable payload still surfaces an error, not a silent drop', async () => {
    // Build a frame whose payload is not valid JSON, but whose headers still
    // mark it as an exception — the parser must not rely on payload JSON
    // parsing succeeding to recognize an exception frame.
    const headerBytes = encodeStringHeader(':message-type', 'exception');
    const payloadBytes = new TextEncoder().encode('not-json{{{');
    const total = 4 + 4 + 4 + headerBytes.length + payloadBytes.length + 4;
    const frame = concatAll(u32(total), u32(headerBytes.length), u32(0), headerBytes, payloadBytes, u32(0));

    const upstream = streamResponse([frame]);
    const sse = await collectSse(bedrockEventStreamToSse(upstream));
    expect(sse).toContain('event: error');
  });
});

describe('translateBedrockResponse (streaming) — end to end through the Anthropic SSE translator', () => {
  test('a mid-stream exception frame comes out as an OpenAI-shaped error chunk', async () => {
    const upstream = streamResponse([
      concatAll(
        chunkFrame({ type: 'message_start', message: { id: 'm1', model: 'x', usage: { input_tokens: 1 } } }),
        exceptionFrame('ModelStreamErrorException', 'Malformed model output'),
      ),
    ]);
    const out = await translateBedrockResponse(upstream, { streaming: true });
    const text = await new Response((out as Response).body).text();
    const errorLine = text
      .split('\n')
      .find((l) => l.startsWith('data:') && l.includes('"error"'))!;
    const parsed = JSON.parse(errorLine.slice(5).trim());
    expect(parsed.error.type).toBe('ModelStreamErrorException');
    expect(parsed.error.message).toBe('Malformed model output');
  });
});
