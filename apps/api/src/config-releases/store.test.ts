import { describe, expect, test } from 'bun:test';
import { S3Client } from '@aws-sdk/client-s3';
import { ObjectStore } from '../object-store/s3';
import {
  CONFIG_ARCHIVE_CONTENT_TYPE,
  MemoryConfigArchiveStore,
  S3ConfigArchiveStore,
  configArchiveKey,
  configArchiveProjectPrefix,
} from './store';

const PROJECT = '5f0c2f36-6a1b-4c1e-9d3a-8a1f3b2c4d5e';
const TREE = 'a'.repeat(40);

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

function missing(): Error {
  const error = new Error('NotFound');
  error.name = 'NotFound';
  (error as { $metadata?: unknown }).$metadata = { httpStatusCode: 404 };
  return error;
}

/** An S3-backed config archive store over a scripted client, with a prefix. */
function s3Store(answers: Array<unknown | Error>, prefix = 'config-releases/') {
  const { client, sent } = fakeClient(answers);
  const objectStore = new ObjectStore(
    () => ({ name: 'config archive', bucket: 'kortix-dev-project-snapshots', region: 'us-west-2' }),
    {
      client,
      // Presigning is pure SigV4 over a real client — no request is sent.
      presignClient: new S3Client({
        region: 'us-west-2',
        credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
      }),
    },
  );
  return { sent, store: new S3ConfigArchiveStore(objectStore, prefix) };
}

describe('configArchiveKey', () => {
  test('lays keys out per project and per config tree ID', () => {
    expect(configArchiveKey(PROJECT, TREE)).toBe(`projects/${PROJECT}/trees/${TREE}.tar.gz`);
    expect(configArchiveProjectPrefix(PROJECT)).toBe(`projects/${PROJECT}/trees/`);
  });

  test('rejects a project ID or tree ID that could escape the prefix', () => {
    expect(() => configArchiveKey('../other', TREE)).toThrow('invalid project id');
    expect(() => configArchiveKey(PROJECT, 'HEAD')).toThrow('invalid config tree id');
    expect(() => configArchiveKey(PROJECT, 'A'.repeat(40))).toThrow('invalid config tree id');
    expect(() => configArchiveProjectPrefix('../other')).toThrow('invalid project id');
  });
});

describe('S3ConfigArchiveStore — the one object store, bucket prefix applied', () => {
  test('putIfAbsent writes the layout key under the configured prefix', async () => {
    const { store, sent } = s3Store([{ ETag: '"1"' }]);
    expect(await store.putIfAbsent(configArchiveKey(PROJECT, TREE), Buffer.from('gz'))).toBe('created');
    expect(sent.map((c) => c.name)).toEqual(['PutObjectCommand']);
    expect(sent[0]!.input.Key).toBe(`config-releases/projects/${PROJECT}/trees/${TREE}.tar.gz`);
    expect(sent[0]!.input.Bucket).toBe('kortix-dev-project-snapshots');
    expect(sent[0]!.input.ContentType).toBe(CONFIG_ARCHIVE_CONTENT_TYPE);
    // AWS honours it, so the first write is kept atomically.
    expect(sent[0]!.input.IfNoneMatch).toBe('*');
  });

  test('a published archive is never overwritten', async () => {
    const conflict = new Error('PreconditionFailed');
    conflict.name = 'PreconditionFailed';
    const { store } = s3Store([conflict]);
    expect(await store.putIfAbsent(configArchiveKey(PROJECT, TREE), Buffer.from('gz'))).toBe('exists');
  });

  test('exists maps a missing object to false', async () => {
    const { store: present } = s3Store([{ ContentLength: 9 }]);
    expect(await present.exists(configArchiveKey(PROJECT, TREE))).toBe(true);
    const { store: absent } = s3Store([missing()]);
    expect(await absent.exists(configArchiveKey(PROJECT, TREE))).toBe(false);
  });

  test('downloadUrl is null for a missing object and presigned otherwise', async () => {
    const { store: absent, sent } = s3Store([missing()]);
    expect(await absent.downloadUrl(configArchiveKey(PROJECT, TREE), 900)).toBeNull();
    expect(sent.map((c) => c.name)).toEqual(['HeadObjectCommand']);

    const { store } = s3Store([{ ContentLength: 9 }]);
    const url = await store.downloadUrl(configArchiveKey(PROJECT, TREE), 900);
    expect(url).toContain(`config-releases/projects/${PROJECT}/trees/${TREE}.tar.gz`);
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=900');
  });

  test('an unconfigured bucket fails where it is used, naming the setting', async () => {
    const { client } = fakeClient([]);
    const store = new S3ConfigArchiveStore(
      new ObjectStore(() => ({ name: 'config archive', bucket: '' }), { client }),
      '',
    );
    await expect(store.exists(configArchiveKey(PROJECT, TREE))).rejects.toThrow(
      'config archive object store bucket is not configured',
    );
  });
});

describe('S3ConfigArchiveStore.pruneProject — bounded retention', () => {
  const key = (n: string) => `projects/${PROJECT}/trees/${n.repeat(40)}.tar.gz`;
  const listing = (names: string[]) => ({
    Contents: names.map((n, i) => ({
      Key: `config-releases/${key(n)}`,
      Size: 10,
      LastModified: new Date(Date.UTC(2026, 0, i + 1)),
    })),
    IsTruncated: false,
  });

  test('keeps the newest N and deletes the rest, under this project only', async () => {
    const { store, sent } = s3Store([listing(['a', 'b', 'c', 'd']), { Deleted: [{ Key: 'x' }, { Key: 'y' }] }]);
    expect(await store.pruneProject(PROJECT, 2)).toEqual([key('b'), key('a')]);
    expect(sent[0]!.name).toBe('ListObjectsV2Command');
    expect(sent[0]!.input.Prefix).toBe(`config-releases/projects/${PROJECT}/trees/`);
    expect(sent[1]!.name).toBe('DeleteObjectsCommand');
    expect((sent[1]!.input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key)).toEqual([
      `config-releases/${key('b')}`,
      `config-releases/${key('a')}`,
    ]);
  });

  test('nothing to delete sends no delete', async () => {
    const { store, sent } = s3Store([listing(['a', 'b'])]);
    expect(await store.pruneProject(PROJECT, 5)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  test('a keep floor of zero is refused: the store must never empty a project', async () => {
    const { store } = s3Store([]);
    await expect(store.pruneProject(PROJECT, 0)).rejects.toThrow('keep must be at least 1');
  });
});

describe('MemoryConfigArchiveStore', () => {
  test('keeps the first write', async () => {
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

  test('prunes per project the same way the S3 store does', async () => {
    const s = new MemoryConfigArchiveStore();
    const keys = ['a', 'b', 'c'].map((n) => configArchiveKey(PROJECT, n.repeat(40)));
    for (const k of keys) await s.putIfAbsent(k, Buffer.from(k));
    expect(await s.pruneProject(PROJECT, 2)).toEqual([keys[0]!]);
    expect([...s.objects.keys()]).toEqual([keys[1]!, keys[2]!]);
  });

  test('failWith makes every call throw', async () => {
    const s = new MemoryConfigArchiveStore();
    s.failWith = new Error('store down');
    await expect(s.exists('k')).rejects.toThrow('store down');
    await expect(s.putIfAbsent('k', Buffer.from('x'))).rejects.toThrow('store down');
    await expect(s.downloadUrl('k', 1)).rejects.toThrow('store down');
  });
});
