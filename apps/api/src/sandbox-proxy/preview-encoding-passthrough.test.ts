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
 *      measured against a real socket WITH THE PROXY'S OWN fetch options
 *      (`decompress: false`): the body arrives as the raw compressed bytes, so
 *      "return Content-Encoding untouched" is exactly right. A default `fetch`
 *      decodes instead, which is what this file measured before, and why the
 *      proxy used to strip the header from a body it had not decoded.
 */
import { describe, expect, test } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';

const { forwardsClientEncoding } = await import('./routes/preview');

describe('forwardsClientEncoding', () => {
  test('the daemon runtime namespace on port 8000 forwards the client negotiation', () => {
    expect(forwardsClientEncoding(8000, '/kortix/runtime/state')).toBe(true);
    expect(forwardsClientEncoding(8000, '/kortix/runtime/messages/ses_abc')).toBe(true);
    // The same namespace on a daemon built before W3.
    expect(forwardsClientEncoding(8000, '/kortix/opencode/state')).toBe(true);
    expect(forwardsClientEncoding(8000, '/kortix/opencode/messages/ses_abc')).toBe(true);
  });

  test('the SSE route is NEVER exempted, even inside the namespace', () => {
    // A gzip stream buffers until a deflate block fills. That is the same
    // defect as buffering the proxy itself, wearing a compression hat.
    expect(forwardsClientEncoding(8000, '/kortix/runtime/events')).toBe(false);
    expect(forwardsClientEncoding(8000, '/kortix/runtime/events?since=41')).toBe(false);
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

describe('what a gzipped daemon response does to the proxy\'s `fetch` (measured)', () => {
  test('with `decompress: false` the proxy holds the RAW compressed bytes, labelled as such', async () => {
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
      const url = `http://127.0.0.1:${server.port}/kortix/runtime/state`;
      // The options `routes/preview.ts` passes to its upstream fetch.
      const proxyFetch = (acceptEncoding: string) =>
        fetch(url, { headers: { 'accept-encoding': acceptEncoding }, redirect: 'manual', decompress: false, duplex: 'half' } as RequestInit);

      const compressed = await proxyFetch('gzip');
      const compressedBody = new Uint8Array(await compressed.arrayBuffer());
      const plain = await proxyFetch('identity');
      const plainBody = new Uint8Array(await plain.arrayBuffer());

      // (1) The saving is real, and it is the whole reason for the exemption:
      // this is the provider hop WS-V measured at ~1.4 s.
      expect(gz.byteLength).toBeLessThan(raw.length / 5);
      expect(compressed.headers.get('content-length')).toBe(String(gz.byteLength));

      // (2) The body is NOT decoded: the proxy holds the gzip bytes, and the
      // headers still describe them. Stripping `content-encoding` here would
      // hand the client gzip bytes labelled as JSON, which no client can read.
      expect(compressed.headers.get('content-encoding')).toBe('gzip');
      expect(compressedBody.byteLength).toBe(gz.byteLength);
      expect([compressedBody[0], compressedBody[1]]).toEqual([0x1f, 0x8b]); // gzip magic
      expect(new TextDecoder().decode(gunzipSync(compressedBody))).toBe(raw);
      expect(new TextDecoder().decode(plainBody)).toBe(raw);

      // Hence `routes/preview.ts` forwards `content-encoding` and
      // `content-length` untouched on this namespace, and the API's compress
      // middleware leaves an already-encoded body alone.
      expect(seenAcceptEncoding).toEqual(['gzip', 'identity']);
    } finally {
      server.stop(true);
    }
  });
});
