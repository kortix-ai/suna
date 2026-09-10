import { afterEach, expect, spyOn, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  uploadPromptAttachment,
  deletePromptAttachment,
  type PromptAttachmentUpload,
} from './prompt-attachments';
import * as limits from '../../attachments/limits';
import * as shared from '../../../../../shared/src/prompt-attachments';

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));
const metadata = {
  attachment_id: 'attachment-1',
  filename: 'a.bin',
  mime: 'application/octet-stream',
  size: 65539,
  expires_at: '2099-01-01T00:00:00Z',
};

test('published SDK limits equal private server limits', () => {
  for (const key of [
    'MAX_PROMPT_ATTACHMENT_BYTES',
    'MAX_PROMPT_ATTACHMENTS_BYTES',
    'MAX_PROMPT_ATTACHMENT_FILES',
    'PROMPT_ATTACHMENT_CHUNK_BYTES',
  ] as const)
    expect(limits[key]).toBe(shared[key]);
});

test('sequential raw chunks report only acknowledged bytes and retain canonical completion', async () => {
  const calls: string[] = [];
  const progress: number[] = [];
  const bytes = new Uint8Array(65539).fill(201);
  configureKortix({
    backendUrl: 'https://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
      if (init?.method === 'PUT') {
        const index = Number(String(url).split('/').at(-1));
        expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(
          bytes.slice(index * 65536, (index + 1) * 65536),
        );
        expect(progress).toEqual(index === 0 ? [] : [65536]);
        return Response.json({
          received_bytes: Math.min((index + 1) * 65536, bytes.length),
          size: bytes.length,
        });
      }
      return Response.json(
        String(url).endsWith('/complete') ? metadata : { ...metadata, chunk_size: 65536 },
      );
    },
  });
  const result = await uploadPromptAttachment('project 1', new File([bytes], 'a.bin'), {
    onProgress: (received) => progress.push(received),
  });
  expect(result).toEqual(metadata);
  expect(progress).toEqual([65536, 65539]);
  expect(calls).toEqual([
    'POST https://api.test/v1/projects/project%201/attachments',
    'PUT https://api.test/v1/projects/project%201/attachments/attachment-1/chunks/0',
    'PUT https://api.test/v1/projects/project%201/attachments/attachment-1/chunks/1',
    'POST https://api.test/v1/projects/project%201/attachments/attachment-1/complete',
  ]);
});

test('manual retry resumes same handle after failed completion without repeating bytes', async () => {
  let handle: PromptAttachmentUpload | undefined;
  let starts = 0,
    chunks = 0,
    completes = 0;
  configureKortix({
    backendUrl: 'https://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') {
        chunks++;
        return Response.json({
          received_bytes: Math.min(chunks * 65536, metadata.size),
          size: metadata.size,
        });
      }
      if (String(url).endsWith('/complete')) {
        completes++;
        return completes === 1
          ? Response.json({ code: 'attachment_invalid', error: 'Invalid' }, { status: 409 })
          : Response.json(metadata);
      }
      starts++;
      return Response.json({ ...metadata, chunk_size: 65536 });
    },
  });
  const file = new File([new Uint8Array(metadata.size)], 'a.bin');
  await expect(
    uploadPromptAttachment('p', file, {
      onUpload: (value) => {
        handle = value;
      },
    }),
  ).rejects.toMatchObject({ code: 'attachment_invalid' });
  expect(handle?.received_bytes).toBe(metadata.size);
  expect(await uploadPromptAttachment('p', file, { resume: handle })).toEqual(metadata);
  expect({ starts, chunks, completes }).toEqual({
    starts: 1,
    chunks: 2,
    completes: 2,
  });
});

test('completion retries typed server deadline and processing with the same ID', async () => {
  let completes = 0;
  configureKortix({
    backendUrl: 'https://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url) => {
      expect(String(url)).toEndWith('/attachment-1/complete');
      completes++;
      if (completes === 1) return Response.json({ code: 'request_deadline' }, { status: 503 });
      if (completes === 2) return Response.json({ code: 'attachment_processing' }, { status: 409 });
      return Response.json(metadata);
    },
  });
  expect(
    await uploadPromptAttachment('p', new File([new Uint8Array(metadata.size)], 'a.bin'), {
      resume: {
        ...metadata,
        chunk_size: 65536,
        received_bytes: metadata.size,
      },
    }),
  ).toEqual(metadata);
  expect(completes).toBe(3);
}, 10000);

test('delete accepts an empty 204 body and returns typed bound conflict quietly', async () => {
  let bound = false,
    reports = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    onError: () => {
      reports++;
    },
    fetch: async () =>
      bound
        ? Response.json({ code: 'attachment_bound' }, { status: 409 })
        : new Response(null, { status: 204 }),
  });
  await deletePromptAttachment('p', 'attachment-1');
  bound = true;
  await expect(deletePromptAttachment('p', 'attachment-1')).rejects.toMatchObject({
    code: 'attachment_bound',
  });
  expect(reports).toBe(0);
});

test('transient chunks retry the same ID/index/bytes and never repeat acknowledged chunks', async () => {
  const puts: { url: string; bytes: number[] }[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') {
        puts.push({
          url: String(url),
          bytes: [...new Uint8Array(await new Response(init.body).arrayBuffer())],
        });
        return puts.length === 1
          ? Response.json({ code: 'attachment_storage_unavailable' }, { status: 503 })
          : Response.json({ received_bytes: 3, size: 3 });
      }
      return Response.json({ ...metadata, size: 3, chunk_size: 65536 });
    },
  });
  await uploadPromptAttachment('p', new File(['abc'], 'a.bin'));
  expect(puts).toHaveLength(2);
  expect(puts[0]).toEqual(puts[1]);
});

test('impossible chunk acknowledgments never advance progress or complete', async () => {
  let completes = 0,
    progress = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (String(url).endsWith('/complete')) completes++;
      return Response.json(
        init?.method === 'PUT'
          ? { received_bytes: metadata.size, size: metadata.size }
          : { ...metadata, chunk_size: 65536 },
      );
    },
  });
  await expect(
    uploadPromptAttachment('p', new File([new Uint8Array(metadata.size)], 'a.bin'), {
      onProgress: () => {
        progress++;
      },
    }),
  ).rejects.toThrow('acknowledgment');
  expect({ completes, progress }).toEqual({ completes: 0, progress: 0 });
});

test('caller cancellation during completion never retries and preserves the upload handle', async () => {
  let completes = 0;
  const abort = new AbortController();
  const resume = { ...metadata, size: 3, received_bytes: 3, chunk_size: 65536 };
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => {
      completes++;
      abort.abort();
      throw new DOMException('Aborted', 'AbortError');
    },
  });
  await expect(
    uploadPromptAttachment('p', new File(['abc'], 'a.bin'), {
      resume,
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ code: 'ABORTED' });
  expect(completes).toBe(1);
  expect(resume.received_bytes).toBe(3);
});

test('client completion timeout never retries', async () => {
  let requests = 0;
  const realSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => realSetTimeout(callback, delay === 30_000 ? 1 : delay, ...args)) as typeof setTimeout);
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => {
      requests++;
      return new Promise(() => {});
    },
  });
  try {
    await expect(
      uploadPromptAttachment('p', new File(['abc'], 'a.bin'), {
        resume: { ...metadata, size: 3, received_bytes: 3, chunk_size: 65536 },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(requests).toBe(1);
  } finally {
    timer.mockRestore();
  }
});

test('completion stops retrying after its separate five-minute budget', async () => {
  const startedAt = Date.now();
  let requests = 0;
  const now = spyOn(Date, 'now').mockImplementation(() => startedAt + (requests ? 300_001 : 0));
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => {
      requests++;
      return Response.json({ code: 'attachment_processing' }, { status: 409 });
    },
  });
  try {
    await expect(
      uploadPromptAttachment('p', new File(['abc'], 'a.bin'), {
        resume: { ...metadata, size: 3, received_bytes: 3, chunk_size: 65536 },
      }),
    ).rejects.toMatchObject({ code: 'attachment_processing' });
    expect(requests).toBe(1);
  } finally {
    now.mockRestore();
  }
});

for (const status of [200, 503]) {
  test(`stalled completion response body (${status}) times out without another request`, async () => {
    let requests = 0;
    let bodyReads = 0;
    const abort = new AbortController();
    const realSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => realSetTimeout(callback, delay === 30_000 ? 10 : delay, ...args)) as typeof setTimeout);
    configureKortix({
      backendUrl: 'https://api.test',
      getToken: async () => 'token',
      fetch: async () => {
        requests++;
        const response = Response.json({}, { status });
        response.json = () => {
          bodyReads++;
          return new Promise(() => {});
        };
        return response;
      },
    });
    const pending = uploadPromptAttachment('p', new File(['abc'], 'a.bin'), {
      signal: abort.signal,
      resume: { ...metadata, size: 3, received_bytes: 3, chunk_size: 65536 },
    }).then(
      () => ({ code: 'UNEXPECTED_SUCCESS' }),
      (error: unknown) => error,
    );
    try {
      const observed = await Promise.race([
        pending,
        new Promise((resolve) => realSetTimeout(() => resolve({ code: 'STILL_PENDING' }), 60)),
      ]);
      expect(observed).toMatchObject({ code: 'TIMEOUT' });
      expect({ requests, bodyReads }).toEqual({ requests: 1, bodyReads: 1 });
    } finally {
      abort.abort();
      await pending;
      timer.mockRestore();
    }
  });
}
