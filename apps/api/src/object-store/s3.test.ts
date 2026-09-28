import { describe, expect, test } from 'bun:test';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  ObjectStore,
  publishOnceMode,
  type PublishOnceMode,
  resolvePresignTarget,
  type ObjectStoreTarget,
} from './s3';

const AWS: ObjectStoreTarget = { name: 'test', bucket: 'b', region: 'us-west-2' };
const SUPABASE: ObjectStoreTarget = {
  name: 'test',
  bucket: 'b',
  region: 'local',
  endpoint: 'http://127.0.0.1:54321/storage/v1/s3',
  forcePathStyle: true,
  accessKeyId: 'id',
  secretAccessKey: 'secret',
};

/** Records every command and answers from a scripted queue. */
function fakeClient(answers: Array<unknown | Error>) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
  } as unknown as S3Client;
  return { client, sent };
}

function s3Error(name: string, httpStatusCode: number): Error {
  const error = new Error(name);
  error.name = name;
  (error as { $metadata?: unknown }).$metadata = { httpStatusCode };
  return error;
}

describe('publishOnceMode — measured per endpoint, never assumed', () => {
  test.each([
    ['', 'if-none-match'],
    ['https://s3.us-west-2.amazonaws.com', 'if-none-match'],
    ['http://127.0.0.1:19100', 'if-none-match'],
    // Measured 2026-09-24 against local Supabase: a second PutObject with
    // `If-None-Match: *` on one key answers 200 and OVERWRITES.
    ['http://127.0.0.1:54321/storage/v1/s3', 'head-then-put'],
    ['https://abc.supabase.co/storage/v1/s3', 'head-then-put'],
    ['http://supabase-kong:8000/storage/v1/s3/', 'head-then-put'],
  ] as Array<[string, PublishOnceMode]>)('%s -> %s', (endpoint, expected) => {
    expect(publishOnceMode(endpoint)).toBe(expected);
  });
});

describe('ObjectStore.putIfAbsent', () => {
  test('conditional endpoint: one PutObject carrying If-None-Match, no HEAD', async () => {
    const { client, sent } = fakeClient([{ ETag: '"1"' }]);
    const store = new ObjectStore(() => AWS, { client });
    expect(await store.putIfAbsent({ key: 'k', body: Buffer.from('x'), contentType: 'application/gzip' })).toBe('created');
    expect(sent.map((c) => c.name)).toEqual(['PutObjectCommand']);
    expect(sent[0]!.input.IfNoneMatch).toBe('*');
    expect(sent[0]!.input.Bucket).toBe('b');
  });

  test('conditional endpoint: 412 means another producer published it first', async () => {
    const { client, sent } = fakeClient([s3Error('PreconditionFailed', 412)]);
    const store = new ObjectStore(() => AWS, { client });
    expect(await store.putIfAbsent({ key: 'k', body: Buffer.from('x'), contentType: 'application/gzip' })).toBe('exists');
    expect(sent).toHaveLength(1);
  });

  test('non-conditional endpoint: HEAD first, and an existing object is never rewritten', async () => {
    const { client, sent } = fakeClient([{ ContentLength: 3, ETag: '"1"' }]);
    const store = new ObjectStore(() => SUPABASE, { client });
    expect(await store.putIfAbsent({ key: 'k', body: Buffer.from('x'), contentType: 'application/gzip' })).toBe('exists');
    expect(sent.map((c) => c.name)).toEqual(['HeadObjectCommand']);
  });

  test('non-conditional endpoint: a missing object is written without If-None-Match', async () => {
    const { client, sent } = fakeClient([s3Error('NotFound', 404), { ETag: '"1"' }]);
    const store = new ObjectStore(() => SUPABASE, { client });
    expect(await store.putIfAbsent({ key: 'k', body: Buffer.from('x'), contentType: 'application/gzip' })).toBe('created');
    expect(sent.map((c) => c.name)).toEqual(['HeadObjectCommand', 'PutObjectCommand']);
    // Sending it would be a lie: this endpoint ignores the header.
    expect(sent[1]!.input.IfNoneMatch).toBeUndefined();
  });

  test('any other error propagates', async () => {
    const { client } = fakeClient([s3Error('AccessDenied', 403)]);
    const store = new ObjectStore(() => AWS, { client });
    await expect(store.putIfAbsent({ key: 'k', body: Buffer.from('x'), contentType: 'application/gzip' })).rejects.toThrow(
      'AccessDenied',
    );
  });

  test('the publish-once mode is logged once per store, naming the endpoint', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      const { client } = fakeClient([s3Error('NotFound', 404), {}, s3Error('NotFound', 404), {}]);
      const store = new ObjectStore(() => SUPABASE, { client });
      await store.putIfAbsent({ key: 'a', body: Buffer.from('x'), contentType: 'application/gzip' });
      await store.putIfAbsent({ key: 'b', body: Buffer.from('x'), contentType: 'application/gzip' });
    } finally {
      console.log = original;
    }
    const mode = lines.filter((l) => l.includes('publish-once'));
    expect(mode).toHaveLength(1);
    expect(mode[0]).toContain('head-then-put');
    expect(mode[0]).toContain('http://127.0.0.1:54321/storage/v1/s3');
  });
});

describe('ObjectStore reads', () => {
  test('head maps a missing object to null and returns the size otherwise', async () => {
    const present = new ObjectStore(() => AWS, { client: fakeClient([{ ContentLength: 12, ETag: '"e"' }]).client });
    expect(await present.head('k')).toEqual({ bytes: 12, etag: '"e"' });
    const absent = new ObjectStore(() => AWS, { client: fakeClient([s3Error('NotFound', 404)]).client });
    expect(await absent.head('k')).toBeNull();
  });

  test('getText maps NoSuchKey to null', async () => {
    const store = new ObjectStore(() => AWS, { client: fakeClient([s3Error('NoSuchKey', 404)]).client });
    expect(await store.getText('k')).toBeNull();
  });

  test('an unconfigured bucket throws where it is used, naming the store', () => {
    const store = new ObjectStore(() => ({ ...AWS, bucket: '  ' }), { client: fakeClient([]).client });
    expect(() => store.bucket).toThrow('test object store bucket is not configured');
  });
});

describe('ObjectStore.list / remove — the retention primitives', () => {
  test('list pages through the prefix and reports key, bytes and age', async () => {
    const { client, sent } = fakeClient([
      {
        Contents: [{ Key: 'p/a', Size: 1, LastModified: new Date('2026-01-01T00:00:00Z') }],
        IsTruncated: true,
        NextContinuationToken: 't1',
      },
      { Contents: [{ Key: 'p/b', Size: 2, LastModified: new Date('2026-01-02T00:00:00Z') }], IsTruncated: false },
    ]);
    const store = new ObjectStore(() => AWS, { client });
    expect(await store.list('p/')).toEqual([
      { key: 'p/a', bytes: 1, lastModified: new Date('2026-01-01T00:00:00Z') },
      { key: 'p/b', bytes: 2, lastModified: new Date('2026-01-02T00:00:00Z') },
    ]);
    expect(sent.map((c) => c.input.ContinuationToken)).toEqual([undefined, 't1']);
  });

  test('list stops at the page budget instead of walking an unbounded prefix', async () => {
    const page = {
      Contents: Array.from({ length: 2 }, (_, i) => ({ Key: `p/${i}`, Size: 1, LastModified: new Date() })),
      IsTruncated: true,
      NextContinuationToken: 't',
    };
    const { client, sent } = fakeClient([page, page, page, page, page]);
    const store = new ObjectStore(() => AWS, { client });
    const found = await store.list('p/', { maxPages: 2, pageSize: 2 });
    expect(found).toHaveLength(4);
    expect(sent).toHaveLength(2);
  });

  test('remove deletes in batches of at most 1000 and counts what went', async () => {
    const { client, sent } = fakeClient([{ Deleted: [{ Key: 'a' }, { Key: 'b' }] }]);
    const store = new ObjectStore(() => AWS, { client });
    expect(await store.remove(['a', 'b'])).toBe(2);
    expect(sent[0]!.name).toBe('DeleteObjectsCommand');
    expect((sent[0]!.input.Delete as { Objects: unknown[] }).Objects).toHaveLength(2);
  });

  test('remove of nothing sends nothing', async () => {
    const { client, sent } = fakeClient([]);
    const store = new ObjectStore(() => AWS, { client });
    expect(await store.remove([])).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('resolvePresignTarget stays the one presign rule', () => {
  test('a custom public endpoint wins over acceleration', () => {
    expect(resolvePresignTarget({ publicEndpoint: 'https://x.test', accelerate: true, forcePathStyle: true })).toEqual({
      endpoint: 'https://x.test',
      useAccelerateEndpoint: false,
      forcePathStyle: true,
      sameAsApiClient: false,
    });
  });
});
