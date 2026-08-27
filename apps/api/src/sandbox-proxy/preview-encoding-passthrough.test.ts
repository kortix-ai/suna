/**
 * Compression passthrough to the daemon's `/kortix/opencode/*` namespace.
 *
 * WS-Z1's first requirement of the API half: *"The preview proxy must forward
 * the client's `Accept-Encoding` to the daemon and return `Content-Encoding`
 * untouched, or the 0.9 KB `/state` becomes 8.7 KB again."* The proxy forces
 * `Accept-Encoding: identity` on every other path, and that default is correct
 * — it is what makes the response REWRITERS (`stripInlineAttachmentBytes` does
 * `await upstream.text()`) safe.
 *
 * So this file pins two things:
 *   1. exactly which paths are exempted, and that the SSE route is not one of
 *      them (a gzip stream buffers, and a buffered event stream is broken);
 *   2. the runtime behaviour that decides what the response side must do —
 *      measured against a real socket, because it is the reason "return
 *      Content-Encoding untouched" is the WRONG instruction for a `fetch`-based
 *      proxy.
 */
import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';

const { forwardsClientEncoding } = await import('./routes/preview');

describe('forwardsClientEncoding', () => {
  test('the daemon runtime namespace on port 8000 forwards the client negotiation', () => {
    expect(forwardsClientEncoding(8000, '/kortix/opencode/state')).toBe(true);
    expect(forwardsClientEncoding(8000, '/kortix/opencode/messages/ses_abc')).toBe(true);
    expect(forwardsClientEncoding(8000, '/kortix/opencode/turn/msg_1')).toBe(true);
  });

  test('the SSE route is NEVER exempted, even inside the namespace', () => {
    // A gzip stream buffers until a deflate block fills. That is the same
    // defect as buffering the proxy itself, wearing a compression hat.
    expect(forwardsClientEncoding(8000, '/kortix/opencode/events')).toBe(false);
    expect(forwardsClientEncoding(8000, '/kortix/opencode/events?since=41')).toBe(false);
  });

  test('every other daemon path keeps identity, so the body rewriters stay safe', () => {
    // `/session/:id/message` is the one this protects: the proxy strips inline
    // attachment bytes out of it with `await upstream.text()`.
    expect(forwardsClientEncoding(8000, '/session/ses_abc/message')).toBe(false);
    expect(forwardsClientEncoding(8000, '/kortix/health')).toBe(false);
    expect(forwardsClientEncoding(8000, '/kortix/diag')).toBe(false);
    expect(forwardsClientEncoding(8000, '/config')).toBe(false);
  });

  test('a user app port never gets it, whatever the path looks like', () => {
    expect(forwardsClientEncoding(3000, '/kortix/opencode/state')).toBe(false);
    expect(forwardsClientEncoding(4096, '/kortix/opencode/state')).toBe(false);
  });

  test('a prefix that merely starts with the namespace name does not match', () => {
    expect(forwardsClientEncoding(8000, '/kortix/opencodex/state')).toBe(false);
    expect(forwardsClientEncoding(8000, '/prefix/kortix/opencode/state')).toBe(false);
  });
});

describe('what a gzipped daemon response actually does to `fetch` (measured)', () => {
  test('the WIRE carries the compressed bytes; `fetch` hands back DECODED ones', async () => {
    // A stand-in daemon that behaves like `kortix-http.ts`: gzip when asked,
    // plain otherwise.
    const raw = JSON.stringify({ agents: { known: true, value: Array.from({ length: 200 }, (_, i) => ({ name: `agent-${i}`, description: 'a projected agent row' })) } });
    const gz = gzipSync(Buffer.from(raw));
    const seenAcceptEncoding: Array<string | null> = [];

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const acceptEncoding = request.headers.get('accept-encoding');
        seenAcceptEncoding.push(acceptEncoding);
        if ((acceptEncoding ?? '').includes('gzip')) {
          return new Response(gz, {
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
              'content-length': String(gz.byteLength),
            },
          });
        }
        return new Response(raw, { headers: { 'content-type': 'application/json' } });
      },
    });

    try {
      const url = `http://127.0.0.1:${server.port}/kortix/opencode/state`;

      const compressed = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
      const compressedBody = new Uint8Array(await compressed.arrayBuffer());
      const plain = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
      const plainBody = new Uint8Array(await plain.arrayBuffer());

      // (1) The saving is real, and it is the whole reason for the exemption:
      // this is the provider hop WS-V measured at ~1.4 s.
      expect(gz.byteLength).toBeLessThan(raw.length / 5);
      expect(compressed.headers.get('content-length')).toBe(String(gz.byteLength));

      // (2) And this is the trap. `fetch` DECODES a `Content-Encoding` body per
      // the WHATWG spec, while leaving the header and the COMPRESSED
      // `Content-Length` on the response object. So "return Content-Encoding
      // untouched" would ship a decoded body labelled gzip with a length that
      // describes different bytes — unreadable by every client.
      expect(compressed.headers.get('content-encoding')).toBe('gzip');
      expect(compressedBody.byteLength).toBe(plainBody.byteLength);
      expect(compressedBody[0]).not.toBe(0x1f); // not a gzip magic byte
      expect(new TextDecoder().decode(compressedBody)).toBe(raw);

      // Hence `routes/preview.ts` strips `content-encoding` + `content-length`
      // on the forwarded path and re-advertises the upstream encoding as
      // `x-kortix-upstream-encoding`. The API's own compress middleware then
      // negotiates the API->client hop independently.
      // Both negotiations reached the stand-in daemon verbatim — which is
      // exactly what the proxy exemption forwards.
      expect(seenAcceptEncoding).toEqual(['gzip', 'identity']);
    } finally {
      server.stop(true);
    }
  });
});
