import { expect, jest, test } from 'bun:test';
import { createPromptAttachmentController } from './prompt-attachments';
import { configureKortix } from '../http/config';
import { createScopedKortix } from '../../node/server';
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENT_FILES,
  MAX_PROMPT_ATTACHMENTS_BYTES,
} from './limits';

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
      return Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
    },
  });
  return { requests, finish: () => finish(Response.json(metadata)) };
}

/** Each file gets `server-<filename>`; its completion answers only when the test says so. */
function perFileTransport() {
  const completions = new Map<string, () => void>();
  const filenames = new Map<string, string>();
  const requests: string[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      const target = String(url);
      requests.push(`${init?.method} ${target}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'PUT') return Response.json({ received_bytes: 3, size: 3 });
      const complete = /\/attachments\/([^/]+)\/complete$/.exec(target);
      if (complete) {
        const attachmentId = decodeURIComponent(complete[1]!);
        return new Promise<Response>((resolve) => {
          completions.set(attachmentId, () =>
            resolve(
              Response.json({
                ...metadata,
                attachment_id: attachmentId,
                filename: filenames.get(attachmentId),
              }),
            ),
          );
        });
      }
      const { filename } = JSON.parse(String(init?.body)) as { filename: string };
      filenames.set(`server-${filename}`, filename);
      return Response.json({
        ...metadata,
        attachment_id: `server-${filename}`,
        filename,
        upload: { kind: 'chunked', chunk_size: 65536 },
      });
    },
  });
  return {
    requests,
    complete: (attachmentId: string) => {
      const finish = completions.get(attachmentId);
      if (!finish) throw new Error(`completion for ${attachmentId} was not requested`);
      finish();
    },
  };
}

test('whenReady resolves parts in id order after completion', async () => {
  const wire = perFileTransport();
  const controller = createPromptAttachmentController('p');
  const [first, second] = controller.addMany([
    new File(['abc'], 'first.txt'),
    new File(['abc'], 'second.txt'),
  ]);
  let parts: unknown;
  const ready = controller.whenReady([second!, first!]).then((value) => (parts = value));
  await settle();
  wire.complete('server-first.txt');
  await settle();
  expect(parts).toBeUndefined();
  wire.complete('server-second.txt');
  await ready;
  expect(parts).toEqual([
    { type: 'file', attachment_id: 'server-second.txt', filename: 'second.txt', mime: 'text/plain' },
    { type: 'file', attachment_id: 'server-first.txt', filename: 'first.txt', mime: 'text/plain' },
  ]);
  controller.dispose();
});

test('whenReady rejects when an item errors', async () => {
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') return Response.json({ received_bytes: 3, size: 3 });
      if (String(url).endsWith('/complete'))
        return Response.json({ error: 'Bytes differ', code: 'attachment_invalid' }, { status: 409 });
      return Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
    },
  });
  const controller = createPromptAttachmentController('p');
  const id = controller.add(new File(['abc'], 'a.txt'));
  await expect(controller.whenReady([id])).rejects.toMatchObject({ code: 'attachment_invalid' });
  expect(controller.getSnapshot().attachments[0]?.status).toBe('error');
  controller.dispose();
});

test('whenReady rejects on remove and on signal abort', async () => {
  const wire = perFileTransport();
  const controller = createPromptAttachmentController('p');
  const [removed, waited] = controller.addMany([
    new File(['abc'], 'removed.txt'),
    new File(['abc'], 'waited.txt'),
  ]);
  const onRemove = controller.whenReady([removed!]);
  await settle();
  await controller.remove(removed!);
  await expect(onRemove).rejects.toThrow('removed');

  const abort = new AbortController();
  const onAbort = controller.whenReady([waited!], { signal: abort.signal });
  abort.abort();
  await expect(onAbort).rejects.toMatchObject({ name: 'AbortError' });
  // A caller abort ends only that wait. The upload continues for a later Send.
  wire.complete('server-waited.txt');
  expect((await controller.whenReady([waited!]))[0]?.attachment_id).toBe('server-waited.txt');
  controller.dispose();
});

test('handed-off entries do not count toward the 20-file limit', () => {
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => new Promise<Response>(() => {}),
  });
  const batch = () =>
    Array.from({ length: MAX_PROMPT_ATTACHMENT_FILES }, (_, index) => new File(['x'], `${index}`));
  const controller = createPromptAttachmentController('p');
  const sent = controller.addMany(batch());
  expect(() => controller.add(new File(['x'], 'extra'))).toThrow('20');
  controller.submit(sent);
  expect(controller.getSnapshot().attachments).toEqual([]);
  expect(controller.addMany(batch())).toHaveLength(MAX_PROMPT_ATTACHMENT_FILES);
  controller.dispose();
});

test('handed-off entries do not count toward the 100 MiB message limit', () => {
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => new Promise<Response>(() => {}),
  });
  const large = (name: string) => {
    const file = new File(['x'], name);
    Object.defineProperty(file, 'size', { value: MAX_PROMPT_ATTACHMENT_BYTES });
    return file;
  };
  const controller = createPromptAttachmentController('p');
  const sent = controller.addMany([large('a'), large('b')]);
  expect(MAX_PROMPT_ATTACHMENT_BYTES * 2).toBe(MAX_PROMPT_ATTACHMENTS_BYTES);
  expect(() => controller.add(large('c'))).toThrow('100 MiB');
  controller.submit(sent);
  expect(controller.add(large('c'))).toBeString();
  controller.dispose();
});

test('dispose does not abort handed-off entries', async () => {
  const wire = perFileTransport();
  const controller = createPromptAttachmentController('p', { concurrency: 1 });
  const [held, queued, dropped] = controller.addMany([
    new File(['abc'], 'held.txt'),
    new File(['abc'], 'queued.txt'),
    new File(['abc'], 'dropped.txt'),
  ]);
  controller.submit([held!, queued!]);
  const ready = controller.whenReady([held!, queued!]);
  const droppedWait = controller.whenReady([dropped!]);
  controller.dispose();
  await expect(droppedWait).rejects.toThrow('disposed');
  await settle();
  wire.complete('server-held.txt');
  // Concurrency 1: the queued hand-off starts only after `held`, after dispose.
  await settle();
  wire.complete('server-queued.txt');
  expect((await ready).map((part) => part.attachment_id)).toEqual([
    'server-held.txt',
    'server-queued.txt',
  ]);
  expect(wire.requests.some((request) => request.includes('dropped'))).toBe(false);
  expect(wire.requests.some((request) => request.startsWith('DELETE'))).toBe(false);
});

test('reclaim returns handed-off entries to the composer list after a failed send', () => {
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => new Promise<Response>(() => {}),
  });
  const controller = createPromptAttachmentController('p');
  const id = controller.add(new File(['abc'], 'a.txt'));
  controller.submit([id]);
  expect(controller.getSnapshot().attachments).toEqual([]);
  controller.reclaim([id]);
  expect(controller.getSnapshot().attachments.map((item) => item.id)).toEqual([id]);
  controller.dispose();
});

test('retry restarts a failed handed-off upload after dispose', async () => {
  let completes = 0,
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
      return Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
    },
  });
  const controller = createPromptAttachmentController('p');
  const id = controller.add(new File(['abc'], 'a.txt'));
  controller.submit([id]);
  // The composer that sent it unmounts; the send keeps its failed upload.
  controller.dispose();
  await expect(controller.whenReady([id])).rejects.toMatchObject({ code: 'attachment_invalid' });
  controller.retry(id);
  expect((await controller.whenReady([id]))[0]?.attachment_id).toBe(metadata.attachment_id);
  expect({ chunks, completes }).toEqual({ chunks: 1, completes: 2 });
});

test('add starts immediately, a same-tick wait holds until completion, File identity survives processing', async () => {
  const wire = transport();
  const controller = createPromptAttachmentController('p');
  const file = new File(['abc'], 'a.txt');
  const id = controller.add(file);
  let parts: unknown;
  const ready = controller.whenReady([id]).then((value) => (parts = value));
  await settle();
  expect(parts).toBeUndefined();
  expect(controller.getSnapshot().attachments[0]).toMatchObject({
    id,
    file,
    status: 'processing',
    receivedBytes: 3,
  });
  expect(controller.getSnapshot().attachments[0]?.file).toBe(file);
  wire.finish();
  await ready;
  expect(parts).toEqual([
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

test('remove prevents stale success', async () => {
  const wire = transport();
  const controller = createPromptAttachmentController('p');
  const id = controller.add(new File(['abc'], 'a.txt'));
  await settle();
  await controller.remove(id);
  wire.finish();
  await settle();
  expect(controller.getSnapshot().attachments).toHaveLength(0);
  expect(wire.requests.filter((url) => url.startsWith('DELETE'))).toHaveLength(1);
  controller.dispose();
});

test('two controllers never mint the same id, so a host can key sent tiles by it', () => {
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => new Promise<Response>(() => {}),
  });
  // Project home and the session composer each own a controller in one tab.
  const home = createPromptAttachmentController('p');
  const chat = createPromptAttachmentController('p');
  const [first] = home.addMany([new File(['a'], 'a.png')]);
  const [second] = chat.addMany([new File(['b'], 'b.png')]);
  expect(first).toBeString();
  expect(second).toBeString();
  expect(first).not.toBe(second);
  home.dispose();
  chat.dispose();
});

test('dispose deletes listed uploads no send holds; a handed-off upload survives', async () => {
  const wire = perFileTransport();
  const controller = createPromptAttachmentController('p');
  const [kept, sent] = controller.addMany([
    new File(['abc'], 'kept.txt'),
    new File(['abc'], 'sent.txt'),
  ]);
  await settle();
  wire.complete('server-kept.txt');
  wire.complete('server-sent.txt');
  await settle();
  expect(controller.getSnapshot().attachments.map((item) => item.status)).toEqual([
    'ready',
    'ready',
  ]);
  controller.submit([sent!]);
  // The composer unmounts: its draft attachments are memory-only, so nothing can send `kept`.
  controller.dispose();
  await settle();
  expect(wire.requests.filter((request) => request.startsWith('DELETE'))).toEqual([
    'DELETE https://api.test/projects/p/attachments/server-kept.txt',
  ]);
  expect(kept).toBeString();
  expect((await controller.whenReady([sent!]))[0]?.attachment_id).toBe('server-sent.txt');
});

test('an expired upload reports attachment_expired, from Retry and from the ready-upload timer', async () => {
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') return Response.json({ received_bytes: 3, size: 3 });
      if (String(url).endsWith('/complete'))
        return Response.json({ error: 'Try again', code: 'attachment_invalid' }, { status: 409 });
      return Response.json({
        ...metadata,
        expires_at: '2000-01-01T00:00:00Z',
        upload: { kind: 'chunked', chunk_size: 65536 },
      });
    },
  });
  const stale = createPromptAttachmentController('p');
  const id = stale.add(new File(['abc'], 'a.txt'));
  await settle();
  expect(stale.getSnapshot().attachments[0]?.status).toBe('error');
  let thrown: unknown;
  try {
    stale.retry(id);
  } catch (error) {
    thrown = error;
  }
  // A host words the reason from the code and offers only Remove.
  expect(thrown).toMatchObject({
    code: 'attachment_expired',
    message: 'Attachment expired. Attach the file again.',
  });
  stale.dispose();

  const expiresAt = new Date(Date.now() + 30).toISOString();
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') return Response.json({ received_bytes: 3, size: 3 });
      if (String(url).endsWith('/complete'))
        return Response.json({ ...metadata, expires_at: expiresAt });
      return Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
    },
  });
  const ready = createPromptAttachmentController('p');
  ready.add(new File(['abc'], 'a.txt'));
  await settle();
  expect(ready.getSnapshot().attachments[0]?.status).toBe('ready');
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(ready.getSnapshot().attachments[0]).toMatchObject({
    status: 'error',
    error: { code: 'attachment_expired' },
  });
  ready.dispose();
});

test('Retry after a size mismatch uploads the same File again as a new attachment', async () => {
  let begins = 0;
  const completes: string[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') return Response.json({ received_bytes: 3, size: 3 });
      const complete = /\/attachments\/([^/]+)\/complete$/.exec(String(url));
      if (complete) {
        const attachmentId = complete[1]!;
        completes.push(attachmentId);
        if (attachmentId === 'attachment-1')
          // The server removed the object and failed the row: this id never completes.
          return completes.length === 1
            ? Response.json(
                { error: 'Attachment size did not match.', code: 'attachment_size_mismatch' },
                { status: 400 },
              )
            : Response.json({ error: 'Attachment failed.', code: 'attachment_failed' }, { status: 409 });
        return Response.json({ ...metadata, attachment_id: attachmentId });
      }
      begins++;
      return Response.json({
        ...metadata,
        attachment_id: `attachment-${begins}`,
        upload: { kind: 'chunked', chunk_size: 65536 },
      });
    },
  });
  const controller = createPromptAttachmentController('p');
  const file = new File(['abc'], 'a.txt');
  const id = controller.add(file);
  await settle();
  expect(controller.getSnapshot().attachments[0]).toMatchObject({
    status: 'error',
    error: { code: 'attachment_size_mismatch' },
  });
  controller.retry(id);
  expect((await controller.whenReady([id]))[0]?.attachment_id).toBe('attachment-2');
  expect(controller.getSnapshot().attachments[0]?.file).toBe(file);
  expect({ begins, completes }).toEqual({ begins: 2, completes: ['attachment-1', 'attachment-2'] });
  controller.dispose();
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
          : Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
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
      return Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
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
  await expect(controller.whenReady([id])).rejects.toMatchObject({ code: 'attachment_invalid' });
  controller.retry(id);
  await settle();
  expect(controller.getSnapshot().attachments[0]?.file).toBe(file);
  expect((await controller.whenReady([id]))[0]?.attachment_id).toBe(metadata.attachment_id);
  expect({ starts, chunks, completes }).toEqual({
    starts: 1,
    chunks: 1,
    completes: 2,
  });
  controller.dispose();
});

test('completion reporting attachment_not_uploaded makes Retry send the direct PUT again', async () => {
  const url = 'https://storage.test/storage/v1/object/upload/sign/staged-files/a?token=t';
  let starts = 0,
    puts = 0,
    completes = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (requestUrl) => {
      if (String(requestUrl) === url) {
        puts++;
        return Response.json({ Key: 'k' });
      }
      if (String(requestUrl).endsWith('/complete')) {
        completes++;
        return completes === 1
          ? Response.json(
              { error: 'Attachment bytes have not arrived.', code: 'attachment_not_uploaded' },
              { status: 409 },
            )
          : Response.json(metadata);
      }
      starts++;
      return Response.json(
        {
          ...metadata,
          upload: {
            kind: 'direct',
            url,
            method: 'PUT',
            headers: { 'content-type': 'text/plain' },
            expires_at: '2099-01-01T00:00:00Z',
          },
        },
        { status: 201 },
      );
    },
  });
  const controller = createPromptAttachmentController('p');
  const id = controller.add(new File(['abc'], 'a.txt'));
  await settle();
  expect(controller.getSnapshot().attachments[0]).toMatchObject({
    status: 'error',
    error: { code: 'attachment_not_uploaded' },
  });
  expect({ starts, puts, completes }).toEqual({ starts: 1, puts: 1, completes: 1 });
  controller.retry(id);
  await settle();
  expect((await controller.whenReady([id]))[0]?.attachment_id).toBe(metadata.attachment_id);
  expect({ starts, puts, completes }).toEqual({ starts: 1, puts: 2, completes: 2 });
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

/** A direct Storage PUT over a fake XMLHttpRequest that the test drives by hand. */
function fakeDirectPut(size: number) {
  const body = { ...metadata, filename: 'p.bin', mime: 'application/octet-stream', size };
  type Progress = (event: { loaded: number; total: number }) => void;
  let xhr: { upload: { onprogress: Progress | null }; status: number; onload: (() => void) | null } | undefined;
  class FakeXMLHttpRequest {
    upload: { onprogress: Progress | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = '';
    open() {}
    setRequestHeader() {}
    send() {
      xhr = this;
    }
    abort() {
      this.onabort?.();
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: FakeXMLHttpRequest,
  });
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url) =>
      String(url).endsWith('/complete')
        ? Response.json(body)
        : Response.json({
            ...body,
            upload: {
              kind: 'direct',
              url: 'https://storage.test/upload',
              method: 'PUT',
              headers: {},
              expires_at: '2099-01-01T00:00:00Z',
            },
          }),
  });
  const controller = createPromptAttachmentController('p');
  return {
    controller,
    async start() {
      controller.add(new File(['x'.repeat(size)], 'p.bin'));
      await settle();
      if (!xhr) throw new Error('the direct PUT did not start');
      return xhr;
    },
    restore() {
      controller.dispose();
      if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original);
      else delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    },
  };
}

test('a 100-step progress sequence emits at most 11 snapshots, and the last percent still lands', async () => {
  const size = 100;
  const { controller, start, restore } = fakeDirectPut(size);
  try {
    const put = await start();
    const snapshots = new Set<unknown>();
    const stop = controller.subscribe(() => snapshots.add(controller.getSnapshot()));
    jest.useFakeTimers();
    try {
      // One acknowledged percent every 10 ms: 100 events over one second.
      for (let loaded = 1; loaded <= size; loaded++) {
        put.upload.onprogress?.({ loaded, total: size });
        jest.advanceTimersByTime(10);
      }
      jest.advanceTimersByTime(100);
    } finally {
      jest.useRealTimers();
    }
    stop();
    expect(snapshots.size).toBeGreaterThan(1);
    expect(snapshots.size).toBeLessThanOrEqual(11);
    // The throttle never swallows the final percent.
    expect(controller.getSnapshot().attachments[0]?.receivedBytes).toBe(size);
    put.status = 200;
    put.onload?.();
    await settle();
    expect(controller.getSnapshot().attachments[0]?.status).toBe('ready');
  } finally {
    restore();
  }
});

test('processing shows every byte, even when the last progress event is still throttled', async () => {
  const size = 100;
  const { controller, start, restore } = fakeDirectPut(size);
  try {
    const put = await start();
    const processing: number[] = [];
    const stop = controller.subscribe(() => {
      const item = controller.getSnapshot().attachments[0];
      if (item?.status === 'processing') processing.push(item.receivedBytes);
    });
    jest.useFakeTimers();
    try {
      // 100 events 10 ms apart. The PUT answers right after the last event,
      // before the throttle interval passes, as a real XHR does.
      for (let loaded = 1; loaded <= size; loaded++) {
        if (loaded > 1) jest.advanceTimersByTime(10);
        put.upload.onprogress?.({ loaded, total: size });
      }
      put.status = 200;
      put.onload?.();
      for (let hop = 0; hop < 50 && processing.length === 0; hop++) await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
    stop();
    expect(processing[0]).toBe(size);
    await settle();
    expect(controller.getSnapshot().attachments[0]?.status).toBe('ready');
  } finally {
    restore();
  }
});

test('remove resolves after local removal; a hanging or failing DELETE never rejects the caller', async () => {
  let deleteAnswer: 'hang' | 'fail' = 'hang';
  const deletes: string[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(url));
        return deleteAnswer === 'hang'
          ? new Promise<Response>(() => {})
          : Response.json({ error: 'storage unavailable' }, { status: 500 });
      }
      if (init?.method === 'PUT') return Response.json({ received_bytes: 3, size: 3 });
      return String(url).endsWith('/complete')
        ? Response.json(metadata)
        : Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
    },
  });
  const controller = createPromptAttachmentController('p');
  const hanging = controller.add(new File(['abc'], 'a.txt'));
  const failing = controller.add(new File(['abc'], 'a.txt'));
  await settle();
  expect(controller.getSnapshot().attachments.map((item) => item.status)).toEqual(['ready', 'ready']);

  const outcome = await Promise.race([
    controller.remove(hanging).then(() => 'resolved'),
    settle().then(() => 'still waiting on the DELETE'),
  ]);
  expect(outcome).toBe('resolved');
  expect(controller.getSnapshot().attachments.map((item) => item.id)).toEqual([failing]);

  deleteAnswer = 'fail';
  await expect(controller.remove(failing)).resolves.toBeUndefined();
  await settle();
  expect(controller.getSnapshot().attachments).toEqual([]);
  expect(deletes).toHaveLength(2);
  controller.dispose();
});

/**
 * The initiation POST is the only answer that names the row the server has
 * already created, so aborting it strands that row until its 24-hour expiry —
 * against a budget of 40 unfinished handles per user.
 */
function deferredInitiationTransport() {
  const requests: string[] = [];
  let answer!: (settlement: 'handle' | 'failure') => void;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      const target = String(url);
      requests.push(`${init?.method} ${target}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'PUT') return Response.json({ received_bytes: 3, size: 3 });
      if (target.endsWith('/complete')) return Response.json(metadata);
      // The initiation answers only when the test says so, and — like a real
      // fetch — rejects the moment its signal aborts.
      return new Promise<Response>((resolve, reject) => {
        answer = (settlement) =>
          settlement === 'handle'
            ? resolve(
                Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } }),
              )
            : reject(new DOMException('Network request failed', 'TypeError'));
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    },
  });
  return { requests, answer: (settlement: 'handle' | 'failure') => answer(settlement) };
}

test('remove during initiation deletes the row the server already created', async () => {
  const wire = deferredInitiationTransport();
  const controller = createPromptAttachmentController('p');
  const id = controller.add(new File(['abc'], 'a.txt'));
  await settle();
  // One initiation in flight, and no handle yet: nothing to delete by id.
  expect(wire.requests).toEqual(['POST https://api.test/projects/p/attachments']);

  await controller.remove(id);
  expect(controller.getSnapshot().attachments).toEqual([]);

  wire.answer('handle');
  await settle();
  expect(wire.requests.filter((line) => line.startsWith('DELETE'))).toEqual([
    'DELETE https://api.test/projects/p/attachments/attachment-1',
  ]);
  // A removed file never sends its bytes, so the deferral costs no upload.
  expect(wire.requests.filter((line) => line.startsWith('PUT'))).toEqual([]);
  controller.dispose();
});

test('remove during an initiation that never yields a handle deletes nothing', async () => {
  const wire = deferredInitiationTransport();
  const controller = createPromptAttachmentController('p');
  const id = controller.add(new File(['abc'], 'a.txt'));
  await settle();
  await controller.remove(id);

  wire.answer('failure');
  await settle();
  expect(wire.requests.filter((line) => line.startsWith('DELETE'))).toEqual([]);
  expect(controller.getSnapshot().attachments).toEqual([]);
  controller.dispose();
});
