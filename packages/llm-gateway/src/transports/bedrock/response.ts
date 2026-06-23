import { translateAnthropicResponse } from '../anthropic';

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
          // Carry any unconsumed leftover. pos can be 0 with bytes still in buf
          // (a sub-12-byte tail the inner loop never entered) — keying off
          // `pos === 0` would drop it, so test for full consumption.
          buf = buf.length === pos ? value : concat(buf.subarray(pos), value);
          pos = 0;

          // Parse every complete frame in the buffer, advancing a read offset
          // instead of re-slicing the whole buffer per frame (O(n), not O(n²)).
          while (buf.length - pos >= 12) {
            const total = readU32(buf, pos);
            // A length below the minimum frame size means the stream desynced;
            // we can't realign, so stop rather than spin forever re-reading it.
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
              // Exception/error frame (throttling, model stream error) — no
              // payload bytes. Surface it instead of silently truncating to a
              // 200, so the failure is visible upstream.
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
