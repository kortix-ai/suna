import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import {
  COMPRESSION_MIN_BYTES,
  compressResponse,
  compressionCandidate,
  negotiateEncoding,
} from './compress';

/**
 * The API shipped every response uncompressed: `accept-encoding: gzip` got back
 * exactly as many bytes as no header at all. The session list is ~98 KB of JSON
 * that gzips to ~6 KB and the browser fetches it several times per session
 * open, so this is transfer the client waits on for no reason.
 *
 * The danger is the opposite mistake — compressing a live stream. `CompressionStream`
 * emits nothing until a deflate block fills, so an SSE surface behind it stops
 * delivering events on time and fails silently. These tests pin BOTH: the big
 * JSON gets compressed, and every streaming/binary shape does not.
 */

const bigJson = JSON.stringify(
  Array.from({ length: 400 }, (_, i) => ({
    session_id: `session-${i}`,
    name: `A session with a reasonably long human title ${i}`,
    status: 'stopped',
  })),
);

function inflate(buffer: ArrayBuffer): Promise<string> {
  return new Response(
    new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text();
}

function app() {
  const instance = new Hono();
  instance.use('*', compressResponse);

  instance.get('/big.json', (c) => c.json(JSON.parse(bigJson)));
  instance.get('/small.json', (c) => c.json({ ok: true }));
  instance.get('/no-content', (c) => c.body(null, 204));
  instance.get('/events', (c) =>
    c.body('data: one\n\ndata: two\n\n'.repeat(200), 200, {
      'content-type': 'text/event-stream',
    }),
  );
  instance.get('/ndjson', (c) =>
    c.body(`${'{"line":1}\n'.repeat(500)}`, 200, {
      'content-type': 'application/x-ndjson',
    }),
  );
  instance.get('/gitpack', (c) =>
    c.body('x'.repeat(50_000), 200, {
      'content-type': 'application/x-git-upload-pack-result',
    }),
  );
  instance.get('/png', (c) =>
    c.body('x'.repeat(50_000), 200, { 'content-type': 'image/png' }),
  );
  instance.get('/already-encoded', (c) =>
    c.body(bigJson, 200, {
      'content-type': 'application/json',
      'content-encoding': 'br',
    }),
  );
  instance.get('/varying', (c) =>
    c.body(bigJson, 200, {
      'content-type': 'application/json',
      vary: 'Origin',
    }),
  );
  return instance;
}

const gzip = { 'accept-encoding': 'gzip' };

describe('negotiateEncoding', () => {
  test('picks gzip when offered', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('gzip');
  });

  test('falls back to deflate when gzip is absent', () => {
    expect(negotiateEncoding('deflate')).toBe('deflate');
  });

  test('honours an explicit refusal of gzip', () => {
    // A client that advertises `gzip;q=0` is saying "not gzip" — offering it
    // anyway is how a proxy ends up handing a client bytes it cannot read.
    expect(negotiateEncoding('gzip;q=0, deflate')).toBe('deflate');
    expect(negotiateEncoding('gzip;q=0')).toBeNull();
  });

  test('never invents an encoding the client did not ask for', () => {
    expect(negotiateEncoding(null)).toBeNull();
    expect(negotiateEncoding('')).toBeNull();
    expect(negotiateEncoding('br')).toBeNull(); // CompressionStream has no brotli
  });

  test('a wildcard means gzip', () => {
    expect(negotiateEncoding('*')).toBe('gzip');
  });
});

describe('compressionCandidate', () => {
  const base = {
    method: 'GET',
    acceptEncoding: 'gzip',
    status: 200,
    contentType: 'application/json',
    contentEncoding: null,
    hasBody: true,
  };

  test('plain JSON is a candidate', () => {
    expect(compressionCandidate(base)).toBe('gzip');
  });

  test('a charset parameter does not hide the type', () => {
    expect(
      compressionCandidate({ ...base, contentType: 'application/json; charset=utf-8' }),
    ).toBe('gzip');
  });

  test('an unknown type is refused — the allowlist fails closed', () => {
    expect(compressionCandidate({ ...base, contentType: 'application/x-tar' })).toBeNull();
    expect(compressionCandidate({ ...base, contentType: null })).toBeNull();
  });

  test('every bodiless or partial status is refused', () => {
    for (const status of [101, 204, 205, 304, 206]) {
      expect(compressionCandidate({ ...base, status })).toBeNull();
    }
  });

  test('HEAD, a websocket, and an empty body are refused', () => {
    expect(compressionCandidate({ ...base, method: 'HEAD' })).toBeNull();
    expect(compressionCandidate({ ...base, isWebSocket: true })).toBeNull();
    expect(compressionCandidate({ ...base, hasBody: false })).toBeNull();
  });

  test('an already-encoded body is never re-encoded', () => {
    expect(compressionCandidate({ ...base, contentEncoding: 'gzip' })).toBeNull();
  });
});

describe('compressResponse', () => {
  test('a large JSON GET is gzipped and decodes byte-identically', async () => {
    const res = await app().request('/big.json', { headers: gzip });

    expect(res.headers.get('content-encoding')).toBe('gzip');
    // The compressed length is unknown until the stream ends, so a stale
    // declared length would truncate or hang the client.
    expect(res.headers.get('content-length')).toBeNull();

    const wire = await res.arrayBuffer();
    expect(wire.byteLength).toBeLessThan(bigJson.length / 4);
    expect(await inflate(wire)).toBe(bigJson);
  });

  test('the same GET without accept-encoding stays raw', async () => {
    const res = await app().request('/big.json');

    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe(bigJson);
  });

  test('SSE is never compressed', async () => {
    // The failure this prevents is silent: events would stop arriving on time
    // rather than erroring.
    const res = await app().request('/events', { headers: gzip });

    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toContain('data: one');
  });

  test('ndjson, git pack and binary responses are never compressed', async () => {
    for (const path of ['/ndjson', '/gitpack', '/png']) {
      const res = await app().request(path, { headers: gzip });
      expect(res.headers.get('content-encoding')).toBeNull();
    }
  });

  test('a body already carrying content-encoding is passed through', async () => {
    const res = await app().request('/already-encoded', { headers: gzip });

    expect(res.headers.get('content-encoding')).toBe('br');
    expect(await res.text()).toBe(bigJson);
  });

  test('a body under the floor stays raw and gains an accurate content-length', async () => {
    const res = await app().request('/small.json', { headers: gzip });
    const body = await res.text();

    expect(res.headers.get('content-encoding')).toBeNull();
    expect(body.length).toBeLessThan(COMPRESSION_MIN_BYTES);
    expect(res.headers.get('content-length')).toBe(String(body.length));
    expect(JSON.parse(body)).toEqual({ ok: true });
  });

  test('a 204 is left completely alone', async () => {
    const res = await app().request('/no-content', { headers: gzip });

    expect(res.status).toBe(204);
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  test('Vary: Accept-Encoding is advertised on both paths', async () => {
    // Without it a shared cache can hand a gzipped body to a client that never
    // asked for one.
    const compressed = await app().request('/big.json', { headers: gzip });
    const raw = await app().request('/big.json');

    for (const res of [compressed, raw]) {
      expect(res.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
    }
  });

  test('an existing Vary is extended, not replaced', async () => {
    const res = await app().request('/varying', { headers: gzip });
    const vary = res.headers.get('vary')?.toLowerCase() ?? '';

    expect(vary).toContain('origin');
    expect(vary).toContain('accept-encoding');
  });

  test('deflate is honoured when that is all the client offers', async () => {
    const res = await app().request('/big.json', {
      headers: { 'accept-encoding': 'deflate' },
    });

    expect(res.headers.get('content-encoding')).toBe('deflate');
    const text = await new Response(
      new Blob([await res.arrayBuffer()])
        .stream()
        .pipeThrough(new DecompressionStream('deflate')),
    ).text();
    expect(text).toBe(bigJson);
  });
});
