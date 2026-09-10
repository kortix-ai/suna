import { expect, test } from 'bun:test';
import { createPromptAttachmentController } from './prompt-attachments';
import { configureKortix } from '../http/config';
import { createScopedKortix } from '../../node/server';
import { MAX_PROMPT_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENT_FILES } from './limits';

const metadata = {
  attachment_id: 'attachment-1',
  filename: 'a.txt',
  mime: 'text/plain',
  size: 3,
  expires_at: '2099-01-01T00:00:00Z',
};
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
function transport() {
  let finish!: (value: Response) => void;
  const requests: string[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      requests.push(`${init?.method} ${url}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'PUT') return Response.json({ received_bytes: 3, size: 3 });
      if (String(url).endsWith('/complete'))
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Response.json({ ...metadata, chunk_size: 65536 });
    },
  });
  return { requests, finish: () => finish(Response.json(metadata)) };
}

test('add starts immediately, blocks same-tick Send, preserves File identity through processing', async () => {
  const wire = transport();
  const controller = createPromptAttachmentController('p');
  const file = new File(['abc'], 'a.txt');
  const id = controller.add(file);
  expect(controller.getSnapshot().canSend).toBe(false);
  expect(() => controller.getReadyParts()).toThrow();
  await settle();
  expect(controller.getSnapshot().attachments[0]).toMatchObject({
    id,
    file,
    status: 'processing',
    receivedBytes: 3,
  });
  expect(controller.getSnapshot().attachments[0]?.file).toBe(file);
  wire.finish();
  await settle();
  expect(controller.getReadyParts()).toEqual([
    {
      type: 'file',
      attachment_id: 'attachment-1',
      filename: 'a.txt',
      mime: 'text/plain',
    },
  ]);
  controller.forget([id]);
  controller.dispose();
  await settle();
  expect(wire.requests.filter((url) => url.startsWith('PUT'))).toHaveLength(1);
  expect(wire.requests.some((url) => url.startsWith('DELETE'))).toBe(false);
});

test('remove prevents stale success, while dispose preserves ready uploads for command binding', async () => {
  const wire = transport();
  const controller = createPromptAttachmentController('p');
  const id = controller.add(new File(['abc'], 'a.txt'));
  await settle();
  await controller.remove(id);
  wire.finish();
  await settle();
  expect(controller.getSnapshot().attachments).toHaveLength(0);
  expect(wire.requests.filter((url) => url.startsWith('DELETE'))).toHaveLength(1);
  const ready = createPromptAttachmentController('p');
  ready.restore(metadata);
  ready.dispose();
  await settle();
  expect(wire.requests.filter((url) => url.startsWith('DELETE'))).toHaveLength(1);
});

test('missing project and shared limits reject synchronously before network', () => {
  const wire = transport();
  expect(() => createPromptAttachmentController(null).add(new File(['x'], 'x'))).toThrow('project');
  const controller = createPromptAttachmentController('p');
  const oversized = new File(['x'], 'large');
  Object.defineProperty(oversized, 'size', {
    value: MAX_PROMPT_ATTACHMENT_BYTES + 1,
  });
  expect(() => controller.add(oversized)).toThrow();
  expect(() =>
    controller.addMany(
      Array.from({ length: MAX_PROMPT_ATTACHMENT_FILES + 1 }, () => new File(['x'], 'x')),
    ),
  ).toThrow();
  expect(wire.requests).toEqual([]);
  expect(controller.getSnapshot().attachments).toEqual([]);
});

test('restore rejects expired metadata and keeps only safe canonical fields', () => {
  const controller = createPromptAttachmentController('p');
  expect(() => controller.restore({ ...metadata, expires_at: '2000-01-01' })).toThrow();
  const id = controller.restore({
    ...metadata,
    url: 'https://secret.test',
  } as typeof metadata);
  expect(controller.getSnapshot().attachments[0]?.attachment).toEqual(metadata);
  controller.retry(id);
  expect(controller.getSnapshot().canSend).toBe(true);
});

test('facade-created controllers retain scoped auth for calls after creation', async () => {
  const tokens: string[] = [];
  const scoped = (token: string) =>
    createScopedKortix({
      backendUrl: 'https://api.test',
      getToken: async () => token,
      fetch: async (_url, init) => {
        tokens.push(new Headers(init?.headers).get('authorization')!);
        return init?.method === 'PUT'
          ? Response.json({ received_bytes: 3, size: 3 })
          : Response.json({ ...metadata, chunk_size: 65536 });
      },
    });
  const a = scoped('a').project('p').attachments.createController();
  const b = scoped('b').project('p').attachments.createController();
  a.add(new File(['abc'], 'a.txt'));
  b.add(new File(['abc'], 'a.txt'));
  await settle();
  expect(tokens.filter((token) => token === 'Bearer a')).toHaveLength(3);
  expect(tokens.filter((token) => token === 'Bearer b')).toHaveLength(3);
});

test('failed completion retries the same ID and File without sending chunks again', async () => {
  let completes = 0,
    starts = 0,
    chunks = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') {
        chunks++;
        return Response.json({ received_bytes: 3, size: 3 });
      }
      if (String(url).endsWith('/complete')) {
        completes++;
        return completes === 1
          ? Response.json({ error: 'Try again', code: 'attachment_invalid' }, { status: 409 })
          : Response.json(metadata);
      }
      starts++;
      return Response.json({ ...metadata, chunk_size: 65536 });
    },
  });
  const controller = createPromptAttachmentController('p');
  const file = new File(['abc'], 'a.txt');
  const id = controller.add(file);
  await settle();
  expect(controller.getSnapshot().attachments[0]).toMatchObject({
    status: 'error',
    error: { code: 'attachment_invalid' },
  });
  expect(() => controller.getReadyParts()).toThrow();
  controller.retry(id);
  await settle();
  expect(controller.getSnapshot().attachments[0]?.file).toBe(file);
  expect(controller.getReadyParts()[0]?.attachment_id).toBe(metadata.attachment_id);
  expect({ starts, chunks, completes }).toEqual({
    starts: 1,
    chunks: 1,
    completes: 2,
  });
  controller.dispose();
});

test('concurrency queues files and cancellation prevents the queued file from starting', async () => {
  let requests = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => {
      requests++;
      return new Promise(() => {});
    },
  });
  const controller = createPromptAttachmentController('p', { concurrency: 1 });
  const [first, second] = controller.addMany([
    new File(['abc'], 'first'),
    new File(['abc'], 'second'),
  ]);
  expect(controller.getSnapshot().attachments.map((item) => item.status)).toEqual([
    'uploading',
    'pending',
  ]);
  await settle();
  controller.abort(second!);
  controller.abort(first!);
  await settle();
  expect(requests).toBe(1);
  expect(controller.getSnapshot().attachments.map((item) => item.status)).toEqual([
    'aborted',
    'aborted',
  ]);
  controller.dispose();
});

test('message byte limit rejects the entire batch before starting any request', () => {
  const wire = transport();
  const files = Array.from({ length: 3 }, () => {
    const file = new File(['x'], 'large');
    Object.defineProperty(file, 'size', { value: MAX_PROMPT_ATTACHMENT_BYTES });
    return file;
  });
  const controller = createPromptAttachmentController('p');
  expect(() => controller.addMany(files)).toThrow('100 MiB');
  expect(controller.getSnapshot().attachments).toEqual([]);
  expect(wire.requests).toEqual([]);
});

test('restoring an existing attachment is idempotent even at the file limit', () => {
  const controller = createPromptAttachmentController('p');
  const ids = Array.from({ length: MAX_PROMPT_ATTACHMENT_FILES }, (_, index) =>
    controller.restore({ ...metadata, attachment_id: `saved-${index}` }),
  );
  expect(controller.restore({ ...metadata, attachment_id: 'saved-0' })).toBe(ids[0]!);
  expect(controller.getSnapshot().attachments).toHaveLength(MAX_PROMPT_ATTACHMENT_FILES);
  controller.dispose();
});
