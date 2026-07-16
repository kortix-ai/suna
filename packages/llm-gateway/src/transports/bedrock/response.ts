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

type HeaderValue = string | number | boolean | Uint8Array;

// Minimal parser for AWS event-stream headers (vnd.amazon.event-stream), used
// by Bedrock's InvokeModelWithResponseStream. Each header is
// [name-len:1][name][type:1][value...], repeated until `length` bytes are
// consumed. We only need enough of this to read `:message-type` /
// `:exception-type` (both type 7 / string), but the other AWS-defined value
// types are decoded too so an unexpected-but-valid header never desyncs the
// parse of the headers that follow it.
function parseHeaders(buf: Uint8Array, offset: number, length: number): Record<string, HeaderValue> {
  const headers: Record<string, HeaderValue> = {};
  const decoder = new TextDecoder();
  const end = offset + length;
  let p = offset;
  while (p < end) {
    if (p + 2 > end) break;
    const nameLen = buf[p];
    p += 1;
    if (p + nameLen + 1 > end) break;
    const name = decoder.decode(buf.subarray(p, p + nameLen));
    p += nameLen;
    const type = buf[p];
    p += 1;
    switch (type) {
      case 0: // bool true
        headers[name] = true;
        break;
      case 1: // bool false
        headers[name] = false;
        break;
      case 2: // byte
        headers[name] = buf[p];
        p += 1;
        break;
      case 3: // short (int16)
        headers[name] = (buf[p] << 8) | buf[p + 1];
        p += 2;
        break;
      case 4: // int32
        headers[name] = readU32(buf, p) | 0;
        p += 4;
        break;
      case 5: {
        // int64 — best-effort as a JS number; large enough for anything
        // Bedrock actually sends in a header value.
        let value = 0;
        for (let i = 0; i < 8; i += 1) value = value * 256 + buf[p + i];
        headers[name] = value;
        p += 8;
        break;
      }
      case 6: {
        // byte array: 2-byte length prefix + bytes.
        const len = (buf[p] << 8) | buf[p + 1];
        p += 2;
        headers[name] = buf.subarray(p, p + len);
        p += len;
        break;
      }
      case 7: {
        // string: 2-byte length prefix + utf8 bytes.
        const len = (buf[p] << 8) | buf[p + 1];
        p += 2;
        headers[name] = decoder.decode(buf.subarray(p, p + len));
        p += len;
        break;
      }
      case 8: // timestamp (int64 ms) — unused here, skip the bytes.
        p += 8;
        break;
      case 9: // uuid (16 bytes)
        headers[name] = buf.subarray(p, p + 16);
        p += 16;
        break;
      default:
        // Unknown/unsupported value type: can't know its width, so stop
        // reading headers rather than risk misinterpreting subsequent bytes.
        return headers;
    }
  }
  return headers;
}

function isExceptionFrame(headers: Record<string, HeaderValue>, frame: { bytes?: string }): boolean {
  const messageType = headers[':message-type'];
  if (messageType === 'exception' || messageType === 'error') return true;
  // Fall back to the shape heuristic (a normal chunk frame always carries
  // `bytes`) for older/self-hosted Bedrock-compatible endpoints that don't
  // set `:message-type`.
  return typeof frame.bytes !== 'string';
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
            const headers = parseHeaders(buf, pos + 12, headersLen);
            const payload = buf.subarray(pos + 12 + headersLen, pos + total - 4);
            pos += total;

            let frame: { bytes?: string; message?: string; Message?: string } = {};
            let payloadParsed = true;
            try {
              frame = JSON.parse(decoder.decode(payload));
            } catch {
              payloadParsed = false;
            }

            if (isExceptionFrame(headers, frame)) {
              // Exception/error frame (throttling, model stream error, etc.) —
              // surface it to the client as a canonical error SSE event
              // instead of only logging it server-side and silently
              // truncating the stream to a clean-looking 200.
              const exceptionType =
                typeof headers[':exception-type'] === 'string'
                  ? (headers[':exception-type'] as string)
                  : 'bedrock_stream_exception';
              const message =
                (payloadParsed && (frame.message ?? frame.Message)) ||
                (payloadParsed ? JSON.stringify(frame) : decoder.decode(payload)) ||
                'bedrock event-stream error frame';
              console.warn('[bedrock] event-stream error frame:', exceptionType, message);
              const errorEvent = { type: 'error', error: { type: exceptionType, message } };
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`));
              continue;
            }

            if (typeof frame.bytes === 'string') {
              const eventJson = decoder.decode(base64ToBytes(frame.bytes));
              controller.enqueue(encoder.encode(`data: ${eventJson}\n\n`));
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

export { bedrockEventStreamToSse };
