import { describe, expect, test } from 'bun:test';
import {
  CONFIG_RELEASES_BUCKET,
  ConfigArchiveStoreError,
  MemoryConfigArchiveStore,
  SupabaseConfigArchiveStore,
  configArchiveKey,
} from './store';

const PROJECT = '5f0c2f36-6a1b-4c1e-9d3a-8a1f3b2c4d5e';
const TREE = 'a'.repeat(40);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A scripted fetch. Each handler answers one path pattern. */
function scriptedFetch(handlers: Array<[RegExp, (call: Call) => Response]>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };
    calls.push(call);
    const handler = handlers.find(([pattern]) => pattern.test(url));
    if (!handler) throw new Error(`unscripted request ${call.method} ${url}`);
    return handler[1](call);
  };
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const DUPLICATE = { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' };
const NOT_FOUND = { statusCode: '404', error: 'not_found', message: 'Object not found' };

function store(handlers: Array<[RegExp, (call: Call) => Response]>) {
  const scripted = scriptedFetch(handlers);
  return {
    ...scripted,
    store: new SupabaseConfigArchiveStore({
      supabaseUrl: 'http://127.0.0.1:54321/',
      serviceRoleKey: 'service-role-test',
      fetch: scripted.fetchImpl,
    }),
  };
}

describe('configArchiveKey', () => {
  test('lays keys out per project and per config tree ID', () => {
    expect(configArchiveKey(PROJECT, TREE)).toBe(`projects/${PROJECT}/trees/${TREE}.tar.gz`);
  });

  test('rejects a project ID or tree ID that could escape the prefix', () => {
    expect(() => configArchiveKey('../other', TREE)).toThrow('invalid project id');
    expect(() => configArchiveKey(PROJECT, 'HEAD')).toThrow('invalid config tree id');
    expect(() => configArchiveKey(PROJECT, 'A'.repeat(40))).toThrow('invalid config tree id');
  });
});

describe('SupabaseConfigArchiveStore', () => {
  test('creates the private bucket once, then uploads without upsert', async () => {
    const { calls, store: s } = store([
      [/\/storage\/v1\/bucket$/, () => json(200, { name: CONFIG_RELEASES_BUCKET })],
      [/\/object\/kortix-config-releases\//, () => json(200, { Key: 'x' })],
    ]);
    const key = configArchiveKey(PROJECT, TREE);
    expect(await s.putIfAbsent(key, Buffer.from('one'))).toBe('created');
    expect(await s.putIfAbsent(key, Buffer.from('two'))).toBe('created');

    const bucketCalls = calls.filter((c) => c.url.endsWith('/storage/v1/bucket'));
    expect(bucketCalls).toHaveLength(1);
    expect(JSON.parse(String(bucketCalls[0]!.body))).toEqual({
      id: CONFIG_RELEASES_BUCKET,
      name: CONFIG_RELEASES_BUCKET,
      public: false,
    });
    const upload = calls.find((c) => c.url.includes('/object/kortix-config-releases/'))!;
    expect(upload.url).toBe(`http://127.0.0.1:54321/storage/v1/object/${CONFIG_RELEASES_BUCKET}/${key}`);
    expect(upload.method).toBe('POST');
    expect(upload.headers['x-upsert']).toBeUndefined();
    expect(upload.headers.Authorization).toBe('Bearer service-role-test');
    expect(upload.headers.apikey).toBe('service-role-test');
  });

  test('treats an existing bucket as ready', async () => {
    const { store: s } = store([
      [/\/storage\/v1\/bucket$/, () => json(400, DUPLICATE)],
      [/\/object\/info\//, () => json(200, { id: 'x' })],
    ]);
    expect(await s.exists(configArchiveKey(PROJECT, TREE))).toBe(true);
  });

  test('retries bucket creation after a failure', async () => {
    let attempts = 0;
    const { store: s } = store([
      [
        /\/storage\/v1\/bucket$/,
        () => (++attempts === 1 ? json(500, { error: 'boom' }) : json(200, { name: CONFIG_RELEASES_BUCKET })),
      ],
      [/\/object\/info\//, () => json(400, NOT_FOUND)],
    ]);
    await expect(s.exists(configArchiveKey(PROJECT, TREE))).rejects.toThrow('create bucket');
    expect(await s.exists(configArchiveKey(PROJECT, TREE))).toBe(false);
    expect(attempts).toBe(2);
  });

  test('maps the native duplicate answer (HTTP 400, statusCode 409) to exists', async () => {
    const { store: s } = store([
      [/\/storage\/v1\/bucket$/, () => json(200, {})],
      [/\/object\/kortix-config-releases\//, () => json(400, DUPLICATE)],
    ]);
    expect(await s.putIfAbsent(configArchiveKey(PROJECT, TREE), Buffer.from('x'))).toBe('exists');
  });

  test('throws on any other upload failure', async () => {
    const { store: s } = store([
      [/\/storage\/v1\/bucket$/, () => json(200, {})],
      [/\/object\/kortix-config-releases\//, () => json(413, { statusCode: '413', error: 'Payload too large' })],
    ]);
    const error = await s.putIfAbsent(configArchiveKey(PROJECT, TREE), Buffer.from('x')).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigArchiveStoreError);
    expect((error as ConfigArchiveStoreError).status).toBe(413);
  });

  test('exists: a not-found body on HTTP 400 is false, a server error throws', async () => {
    let answer = json(400, NOT_FOUND);
    const { store: s } = store([
      [/\/storage\/v1\/bucket$/, () => json(200, {})],
      [/\/object\/info\//, () => answer],
    ]);
    const key = configArchiveKey(PROJECT, TREE);
    expect(await s.exists(key)).toBe(false);
    answer = json(503, { error: 'unavailable' });
    await expect(s.exists(key)).rejects.toThrow('HTTP 503');
  });

  test('downloadUrl resolves the signed path against /storage/v1 with the requested TTL', async () => {
    const { calls, store: s } = store([
      [/\/storage\/v1\/bucket$/, () => json(200, {})],
      [/\/object\/sign\//, () => json(200, { signedURL: `/object/sign/${CONFIG_RELEASES_BUCKET}/k?token=t` })],
    ]);
    const url = await s.downloadUrl(configArchiveKey(PROJECT, TREE), 900);
    expect(url).toBe(`http://127.0.0.1:54321/storage/v1/object/sign/${CONFIG_RELEASES_BUCKET}/k?token=t`);
    const sign = calls.find((c) => c.url.includes('/object/sign/'))!;
    expect(JSON.parse(String(sign.body))).toEqual({ expiresIn: 900 });
  });

  test('NoSuchBucket after a successful create is an error, never "not found"', async () => {
    const noBucket = { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found', code: 'NoSuchBucket' };
    let creates = 0;
    const { store: s } = store([
      [/\/storage\/v1\/bucket$/, () => (creates++, json(200, {}))],
      [/\/object\//, () => json(400, noBucket)],
    ]);
    const key = configArchiveKey(PROJECT, TREE);
    await expect(s.exists(key)).rejects.toThrow('service-role key is probably rejected');
    await expect(s.downloadUrl(key, 900)).rejects.toThrow('service-role key is probably rejected');
    await expect(s.putIfAbsent(key, Buffer.from('x'))).rejects.toThrow('service-role key is probably rejected');
    // Each failure resets the bucket, so the next call re-creates it.
    expect(creates).toBe(3);
  });

  test('downloadUrl returns null for a missing object', async () => {
    const { store: s } = store([
      [/\/storage\/v1\/bucket$/, () => json(200, {})],
      [/\/object\/sign\//, () => json(400, NOT_FOUND)],
    ]);
    expect(await s.downloadUrl(configArchiveKey(PROJECT, TREE), 900)).toBeNull();
  });
});

describe('MemoryConfigArchiveStore', () => {
  test('keeps the first write, like the native API', async () => {
    const s = new MemoryConfigArchiveStore();
    const key = configArchiveKey(PROJECT, TREE);
    expect(await s.exists(key)).toBe(false);
    expect(await s.downloadUrl(key, 900)).toBeNull();
    expect(await s.putIfAbsent(key, Buffer.from('first'))).toBe('created');
    expect(await s.putIfAbsent(key, Buffer.from('second'))).toBe('exists');
    expect(s.objects.get(key)!.toString()).toBe('first');
    expect(await s.exists(key)).toBe(true);
    expect(await s.downloadUrl(key, 900)).toContain(key);
  });

  test('failWith makes every call throw', async () => {
    const s = new MemoryConfigArchiveStore();
    s.failWith = new Error('store down');
    await expect(s.exists('k')).rejects.toThrow('store down');
    await expect(s.putIfAbsent('k', Buffer.from('x'))).rejects.toThrow('store down');
    await expect(s.downloadUrl('k', 1)).rejects.toThrow('store down');
  });
});
