/**
 * Transport contract for prompt attachments, with a recording fake database and
 * a fake Storage HTTP origin. `integration-prompt-attachments.test.ts` owns the
 * real-PostgreSQL races; this file owns which Storage calls each mode makes,
 * and whether any of them runs inside a database transaction.
 */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mockConfigModule } from './reaping/test-support/mock-config';

const configModule = mockConfigModule({
  SUPABASE_URL: 'http://supabase-kong:8000',
  SUPABASE_PUBLIC_URL: 'https://preview.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  PROMPT_ATTACHMENT_UPLOAD_MODE: 'direct',
  PROMPT_ATTACHMENT_CHUNK_BYTES: 65536,
});
const config = configModule.config as Record<string, unknown>;
mock.module('../config', () => configModule);

type Row = Record<string, unknown>;
const events: string[] = [];
let inTransaction = false;
let row: Row | undefined;

function chain(op: 'select' | 'insert' | 'update' | 'delete') {
  let payload: Row | undefined;
  const run = () => {
    events.push(`${inTransaction ? 'tx:' : ''}db:${op}`);
    if (op === 'insert') {
      row = {
        status: 'uploading',
        receivedBytes: 0,
        sha256: null,
        finalizeToken: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...payload,
      };
      return [row];
    }
    if (op === 'update') {
      if (!row) return [];
      row = { ...row, ...payload };
      return [row];
    }
    if (op === 'delete') {
      row = undefined;
      return [];
    }
    return row ? [row] : [];
  };
  const builder: object = new Proxy(() => {}, {
    get(_target, property) {
      if (property === 'then') {
        const result = Promise.resolve().then(run);
        return result.then.bind(result);
      }
      return (...args: unknown[]) => {
        if (property === 'set' || property === 'values') payload = args[0] as Row;
        return builder;
      };
    },
  });
  return builder;
}
interface FakeDb {
  select(): object;
  insert(): object;
  update(): object;
  delete(): object;
  execute(): Promise<unknown[]>;
  transaction<T>(work: (tx: FakeDb) => Promise<T>): Promise<T>;
}
const fakeDb: FakeDb = {
  select: () => chain('select'),
  insert: () => chain('insert'),
  update: () => chain('update'),
  delete: () => chain('delete'),
  // begin's per-user advisory lock.
  execute: async () => {
    events.push(`${inTransaction ? 'tx:' : ''}db:execute`);
    return [];
  },
  async transaction<T>(work: (tx: typeof fakeDb) => Promise<T>): Promise<T> {
    inTransaction = true;
    events.push('tx:begin');
    try {
      return await work(fakeDb);
    } finally {
      events.push('tx:end');
      inTransaction = false;
    }
  },
};
mock.module('../shared/db', () => ({ db: fakeDb, hasDatabase: true }));

const storage: { method: string; path: string; inTransaction: boolean; body?: unknown }[] = [];
let object: Uint8Array | undefined;
/** Bytes written by path inside the bucket (chunks, the assembled file). A GET falls back to `object`. */
const stored = new Map<string, Uint8Array>();
/** A Storage DELETE that never answers. */
let hangDelete = false;
const bucketPath = (path: string) => path.slice(path.indexOf('/staged-files/'));
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const record = { method: request.method, path, inTransaction } as (typeof storage)[number];
    storage.push(record);
    events.push(`${inTransaction ? 'tx:' : ''}storage:${request.method}`);
    if (path.startsWith('/storage/v1/object/upload/sign/')) {
      // Storage answers relative to /storage/v1; storage-js prefixes its own base URL.
      return Response.json({ url: `${path.slice('/storage/v1'.length)}?token=signed-token` });
    }
    if (request.method === 'DELETE') {
      record.body = await request.json();
      if (hangDelete) return new Promise<Response>(() => {});
      object = undefined;
      return Response.json([]);
    }
    if (request.method === 'GET') {
      const bytes = stored.get(bucketPath(path)) ?? object;
      if (!bytes) return Response.json({ statusCode: '404', error: 'not_found' }, { status: 400 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            for (let offset = 0; offset < bytes.length; offset += 2)
              stream.enqueue(bytes.slice(offset, offset + 2));
            stream.close();
          },
        }),
      );
    }
    const written = new Uint8Array(await request.arrayBuffer());
    record.body = written.byteLength;
    stored.set(bucketPath(path), written);
    return Response.json({ Key: path });
  },
  { preconnect: originalFetch.preconnect },
) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const attachments = await import('./prompt-attachments');
const scope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};

beforeEach(() => {
  events.length = 0;
  storage.length = 0;
  row = undefined;
  object = undefined;
  stored.clear();
  hangDelete = false;
  config.PROMPT_ATTACHMENT_UPLOAD_MODE = 'direct';
  config.PROMPT_ATTACHMENT_CHUNK_BYTES = 65536;
});

test('begin in direct mode returns a public-origin signed upload URL', async () => {
  const handle = await attachments.beginPromptAttachment(scope, {
    filename: 'shot.png',
    mime: 'image/png',
    size: 5,
  });
  const objectPath = `prompt-attachments/${scope.projectId}/${handle.attachment_id}/file`;
  expect(handle.upload).toEqual({
    kind: 'direct',
    url: `https://preview.example/storage/v1/object/upload/sign/staged-files/${objectPath}?token=signed-token`,
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'cache-control': 'max-age=3600', 'x-upsert': 'false' },
    expires_at: expect.any(String),
  });
  expect(Date.parse(handle.upload.kind === 'direct' ? handle.upload.expires_at : '')).toBeGreaterThan(
    Date.now(),
  );
  expect(handle).toMatchObject({ filename: 'shot.png', mime: 'image/png', size: 5 });
  expect(storage.map((call) => `${call.method} ${call.path}`)).toEqual([
    `POST /storage/v1/object/upload/sign/staged-files/${objectPath}`,
  ]);
  expect(JSON.stringify(handle)).not.toContain('supabase-kong');
});

test('begin with an existing attachment_id re-signs the same row and inserts nothing', async () => {
  const first = await attachments.beginPromptAttachment(scope, {
    filename: 'a.txt',
    mime: 'text/plain',
    size: 5,
  });
  events.length = 0;
  const again = await attachments.beginPromptAttachment(scope, {
    attachment_id: first.attachment_id,
    filename: 'a.txt',
    mime: 'text/plain',
    size: 5,
  });
  expect(again.attachment_id).toBe(first.attachment_id);
  expect(again.upload.kind).toBe('direct');
  expect(events).not.toContain('db:insert');
  await expect(
    attachments.beginPromptAttachment(
      { ...scope, userId: '44444444-4444-4444-8444-444444444444' },
      { attachment_id: first.attachment_id, filename: 'a.txt', mime: 'text/plain', size: 5 },
    ),
  ).rejects.toMatchObject({ status: 404, code: 'attachment_not_found' });
});

test('complete in direct mode never calls storage upload', async () => {
  const handle = await attachments.beginPromptAttachment(scope, {
    filename: 'a.txt',
    mime: 'text/plain',
    size: 5,
  });
  object = new TextEncoder().encode('hello');
  storage.length = 0;
  // begin's budget transaction is not part of completion.
  events.length = 0;
  const ready = await attachments.completePromptAttachment(scope, handle.attachment_id);
  expect(ready).toMatchObject({ attachment_id: handle.attachment_id, size: 5 });
  expect(storage.map((call) => call.method)).toEqual(['GET']);
  expect(row).toMatchObject({
    status: 'ready',
    sha256: createHash('sha256').update('hello').digest('hex'),
  });
  expect(events.some((event) => event.startsWith('tx:'))).toBe(false);
});

test('complete rejects a size mismatch and removes the object', async () => {
  const handle = await attachments.beginPromptAttachment(scope, {
    filename: 'a.txt',
    mime: 'text/plain',
    size: 5,
  });
  object = new TextEncoder().encode('hello!');
  storage.length = 0;
  await expect(
    attachments.completePromptAttachment(scope, handle.attachment_id),
  ).rejects.toMatchObject({ status: 400, code: 'attachment_size_mismatch' });
  expect(storage.map((call) => call.method)).toEqual(['GET', 'DELETE']);
  expect(storage[1]?.body).toEqual({
    prefixes: [`prompt-attachments/${scope.projectId}/${handle.attachment_id}/file`],
  });
  expect(row?.status).toBe('failed');
  await expect(
    attachments.completePromptAttachment(scope, handle.attachment_id),
  ).rejects.toMatchObject({ status: 409, code: 'attachment_failed' });
});

test('complete rejects a stored object shorter than its declaration and removes it', async () => {
  const handle = await attachments.beginPromptAttachment(scope, {
    filename: 'a.txt',
    mime: 'text/plain',
    size: 5,
  });
  object = new TextEncoder().encode('hel');
  storage.length = 0;
  await expect(
    attachments.completePromptAttachment(scope, handle.attachment_id),
  ).rejects.toMatchObject({ status: 400, code: 'attachment_size_mismatch' });
  expect(storage.map((call) => call.method)).toEqual(['GET', 'DELETE']);
  expect(row?.status).toBe('failed');
});

test('chunked completion answers when the file is ready, without waiting for chunk removal', async () => {
  config.PROMPT_ATTACHMENT_UPLOAD_MODE = 'chunked';
  config.PROMPT_ATTACHMENT_CHUNK_BYTES = 4;
  const handle = await attachments.beginPromptAttachment(scope, {
    filename: 'a.txt',
    mime: 'text/plain',
    size: 6,
  });
  await attachments.uploadPromptAttachmentChunk(
    scope,
    handle.attachment_id,
    0,
    new TextEncoder().encode('hell'),
  );
  await attachments.uploadPromptAttachmentChunk(
    scope,
    handle.attachment_id,
    1,
    new TextEncoder().encode('o!'),
  );
  // Chunk removal is cleanup: a slow Storage DELETE must not hold the 90 s completion bound.
  hangDelete = true;
  const answer = await Promise.race([
    attachments.completePromptAttachment(scope, handle.attachment_id),
    new Promise((resolve) => setTimeout(() => resolve('still waiting on chunk removal'), 1_000)),
  ]);
  expect(answer).toMatchObject({ attachment_id: handle.attachment_id, size: 6 });
  expect(row).toMatchObject({
    status: 'ready',
    sha256: createHash('sha256').update('hello!').digest('hex'),
  });
  // The removal is still requested, after the answer.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(storage.some((call) => call.method === 'DELETE')).toBe(true);
});

test('complete in direct mode reports a missing object as not uploaded and keeps the row', async () => {
  const handle = await attachments.beginPromptAttachment(scope, {
    filename: 'a.txt',
    mime: 'text/plain',
    size: 5,
  });
  await expect(
    attachments.completePromptAttachment(scope, handle.attachment_id),
  ).rejects.toMatchObject({ status: 409, code: 'attachment_not_uploaded' });
  expect(row?.status).toBe('uploading');
});

test('begin in chunked mode returns chunk_size from config', async () => {
  config.PROMPT_ATTACHMENT_UPLOAD_MODE = 'chunked';
  config.PROMPT_ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024;
  const handle = await attachments.beginPromptAttachment(scope, {
    filename: 'a.txt',
    mime: 'text/plain',
    size: 5,
  });
  expect(handle.upload).toEqual({ kind: 'chunked', chunk_size: 8 * 1024 * 1024 });
  expect(storage).toEqual([]);
});

test('chunk route performs no Storage write inside db.transaction', async () => {
  config.PROMPT_ATTACHMENT_UPLOAD_MODE = 'chunked';
  config.PROMPT_ATTACHMENT_CHUNK_BYTES = 4;
  const handle = await attachments.beginPromptAttachment(scope, {
    filename: 'a.txt',
    mime: 'text/plain',
    size: 6,
  });
  events.length = 0;
  expect(
    await attachments.uploadPromptAttachmentChunk(
      scope,
      handle.attachment_id,
      0,
      new Uint8Array([1, 2, 3, 4]),
    ),
  ).toEqual({ received_bytes: 4, size: 6 });
  expect(
    await attachments.uploadPromptAttachmentChunk(
      scope,
      handle.attachment_id,
      1,
      new Uint8Array([5, 6]),
    ),
  ).toEqual({ received_bytes: 6, size: 6 });
  expect(events.filter((event) => event.startsWith('tx:'))).toEqual([]);
  expect(events.slice(0, 4)).toEqual(['db:select', 'db:update', 'storage:POST', 'db:update']);
  expect(storage.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([
    `/storage/v1/object/staged-files/prompt-attachments/${scope.projectId}/${handle.attachment_id}/chunks/0`,
    `/storage/v1/object/staged-files/prompt-attachments/${scope.projectId}/${handle.attachment_id}/chunks/1`,
  ]);
  expect(
    await attachments.uploadPromptAttachmentChunk(
      scope,
      handle.attachment_id,
      0,
      new Uint8Array([1, 2, 3, 4]),
    ),
  ).toEqual({ received_bytes: 6, size: 6 });
});

test('the chunk route is refused in direct mode', () => {
  let refusal: unknown;
  try {
    attachments.assertChunkedPromptAttachmentUpload();
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({ status: 409, code: 'attachment_upload_mode' });
  config.PROMPT_ATTACHMENT_UPLOAD_MODE = 'chunked';
  expect(() => attachments.assertChunkedPromptAttachmentUpload()).not.toThrow();
});
