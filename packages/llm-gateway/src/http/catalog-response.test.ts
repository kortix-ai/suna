/**
 * The `/models` wire format.
 *
 * The catalog is the biggest response this gateway serves (~3.3MB for a full
 * project catalog) and its most latency-sensitive consumer is a sandbox in
 * another region fetching it at boot to reconcile OpenCode's provider map.
 * Uncompressed it needs a fetch budget so large it stops being a background
 * task. These tests pin the three properties that make the compressed path
 * safe: the bytes shrink, the decoded JSON is byte-identical, and a client that
 * did not ask for gzip never receives it.
 */
import { describe, expect, test } from 'bun:test';
import {
  catalogJsonResponse,
  gzipRelayedBody,
  sanitizeRelayedHeaders,
} from './catalog-response';

const CATALOG = {
  models: Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [
      `provider${i % 8}/model-${i}`,
      {
        name: `Model ${i}`,
        provider: `provider${i % 8}`,
        reasoning: true,
        tool_call: true,
        limit: { context: 200_000, output: 32_000 },
        cost: { input: 1.25, output: 10 },
      },
    ]),
  ),
};

async function bodyBytes(res: Response): Promise<number> {
  return (await res.arrayBuffer()).byteLength;
}

describe('catalogJsonResponse', () => {
  test('gzips for a client that accepts it, and the decoded JSON is identical', async () => {
    const plain = catalogJsonResponse(CATALOG, { acceptEncoding: 'identity' });
    const gzip = catalogJsonResponse(CATALOG, { acceptEncoding: 'gzip, deflate, br' });

    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(gzip.headers.get('content-encoding')).toBe('gzip');

    const plainBytes = await bodyBytes(plain.clone());
    const gzipBytes = await bodyBytes(gzip.clone());
    expect(gzipBytes).toBeLessThan(plainBytes / 4);

    // The whole point: the same JSON comes out the other end.
    expect(await plain.json()).toEqual(CATALOG);
  });

  test('never gzips a client that did not offer it — including `gzip;q=0`', () => {
    for (const header of [undefined, null, '', 'identity', 'br', 'gzip;q=0', 'deflate, gzip;q=0']) {
      expect(catalogJsonResponse(CATALOG, { acceptEncoding: header }).headers.get('content-encoding')).toBeNull();
    }
    expect(catalogJsonResponse(CATALOG, { acceptEncoding: 'gzip;q=0.5' }).headers.get('content-encoding')).toBe('gzip');
  });

  test('a tiny body is not worth compressing', () => {
    const managedOnly = catalogJsonResponse({ models: {} }, { acceptEncoding: 'gzip' });
    expect(managedOnly.headers.get('content-encoding')).toBeNull();
  });

  test('caching headers are set, and PRIVATE — the catalog is per-principal', () => {
    const res = catalogJsonResponse(CATALOG, { acceptEncoding: 'gzip' });
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
    // Without Vary a shared cache could hand a gzip body to an identity client.
    expect(res.headers.get('vary')).toBe('accept-encoding');
    expect(res.headers.get('etag')).toMatch(/^W\/"[a-z0-9]+-[a-z0-9]+"$/);
  });

  test('a matching If-None-Match short-circuits to 304 with no body', async () => {
    const first = catalogJsonResponse(CATALOG, { acceptEncoding: 'gzip' });
    const etag = first.headers.get('etag')!;

    const conditional = catalogJsonResponse(CATALOG, {
      acceptEncoding: 'gzip',
      ifNoneMatch: etag,
    });
    expect(conditional.status).toBe(304);
    expect(await bodyBytes(conditional)).toBe(0);

    // A DIFFERENT catalog must not match the old tag.
    const changed = catalogJsonResponse(
      { models: { ...CATALOG.models, 'kortix/new': { name: 'New' } } },
      { ifNoneMatch: etag },
    );
    expect(changed.status).toBe(200);
  });
});

describe('reverse-proxy relay', () => {
  test('strips the byte-description headers a fetch-based relay no longer holds', () => {
    // The exact shape that broke: `fetch` inflated the body and copied
    // `content-encoding: gzip` verbatim, so the next client hit a zlib error.
    const upstream = new Headers({
      'content-encoding': 'gzip',
      'content-length': '1234',
      'transfer-encoding': 'chunked',
      'content-type': 'application/json',
      etag: 'W/"abc"',
    });
    const relayed = sanitizeRelayedHeaders(upstream);

    expect(relayed.get('content-encoding')).toBeNull();
    expect(relayed.get('content-length')).toBeNull();
    expect(relayed.get('transfer-encoding')).toBeNull();
    // Everything that still describes the payload survives.
    expect(relayed.get('content-type')).toBe('application/json');
    expect(relayed.get('etag')).toBe('W/"abc"');
  });

  test('re-compresses for the hop that matters, and only when asked', async () => {
    const raw = new TextEncoder().encode(JSON.stringify(CATALOG));
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;

    const plain = gzipRelayedBody(buffer, 'identity');
    expect(plain.contentEncoding).toBeNull();

    const gzip = gzipRelayedBody(buffer, 'gzip');
    expect(gzip.contentEncoding).toBe('gzip');
    const compressed = await new Response(gzip.body as ReadableStream).arrayBuffer();
    expect(compressed.byteLength).toBeLessThan(buffer.byteLength / 4);
  });
});
