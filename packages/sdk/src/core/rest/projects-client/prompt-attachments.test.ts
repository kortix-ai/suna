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
const MiB = 1024 * 1024;
const metadata = {
  attachment_id: 'attachment-1',
  filename: 'a.bin',
  mime: 'application/octet-stream',
  size: 65539,
  expires_at: '2099-01-01T00:00:00Z',
};
const signedUrl =
  'https://storage.test/storage/v1/object/upload/sign/staged-files/prompt-attachments/p/attachment-1/file?token=first';
const freshUrl = signedUrl.replace('token=first', 'token=fresh');
const directHeaders = {
  'content-type': 'application/octet-stream',
  'cache-control': 'max-age=3600',
  'x-upsert': 'false',
};
const direct = (url = signedUrl, expires_at = '2099-01-01T00:00:00Z') => ({
  kind: 'direct' as const,
  url,
  method: 'PUT' as const,
  headers: directHeaders,
  expires_at,
});
const chunked = (chunk_size = 65536) => ({ kind: 'chunked' as const, chunk_size });

/** Replaces only the listed timer delays, so request deadlines fire at once in tests. */
function shortenTimers(delays: Record<number, number>) {
  const realSetTimeout = globalThis.setTimeout;
  return spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) =>
    realSetTimeout(
      callback,
      delay !== undefined && delay in delays ? delays[delay] : delay,
      ...args,
    )) as typeof setTimeout);
}

test('published SDK limits equal private server limits; the chunk size is server-private', () => {
  for (const key of [
    'MAX_PROMPT_ATTACHMENT_BYTES',
    'MAX_PROMPT_ATTACHMENTS_BYTES',
    'MAX_PROMPT_ATTACHMENT_FILES',
  ] as const)
    expect(limits[key]).toBe(shared[key]);
  expect('PROMPT_ATTACHMENT_CHUNK_BYTES' in limits).toBe(false);
});

test('direct handle uploads a 10 MiB file with exactly 1 begin, 1 PUT, 1 complete', async () => {
  const size = 10 * MiB;
  const calls: string[] = [];
  const progress: number[] = [];
  let put: { bytes: number; headers: Headers } | undefined;
  configureKortix({
    backendUrl: 'https://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (String(url) === signedUrl) {
        put = {
          bytes: (await new Response(init?.body).arrayBuffer()).byteLength,
          headers: new Headers(init?.headers),
        };
        return Response.json({ Key: 'staged-files/prompt-attachments/p/attachment-1/file' });
      }
      if (String(url).endsWith('/complete')) return Response.json({ ...metadata, size });
      return Response.json({ ...metadata, size, upload: direct() }, { status: 201 });
    },
  });
  const result = await uploadPromptAttachment('p', new File([new Uint8Array(size)], 'a.bin'), {
    onProgress: (received) => progress.push(received),
  });
  expect(result).toEqual({ ...metadata, size });
  expect(calls).toEqual([
    'POST https://api.test/v1/projects/p/attachments',
    `PUT ${signedUrl}`,
    'POST https://api.test/v1/projects/p/attachments/attachment-1/complete',
  ]);
  expect(put?.bytes).toBe(size);
  expect(Object.fromEntries(put!.headers)).toEqual(directHeaders);
  expect(progress).toEqual([0, size]);
});

test('direct PUT carries no Authorization header and reports XHR-acknowledged bytes', async () => {
  const sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] =
    [];
  class FakeXMLHttpRequest {
    upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null } = {
      onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = '';
    private request = { method: '', url: '', headers: {} as Record<string, string>, body: null as unknown };
    open(method: string, url: string) {
      this.request.method = method;
      this.request.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.request.headers[name.toLowerCase()] = value;
    }
    send(body: unknown) {
      this.request.body = body;
      sent.push(this.request);
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: 1, total: 3 });
        this.upload.onprogress?.({ loaded: 3, total: 3 });
        this.status = 200;
        this.responseText = '{"Key":"k"}';
        this.onload?.();
      });
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
  const platform: string[] = [];
  const progress: number[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      platform.push(`${init?.method} ${url} ${new Headers(init?.headers).get('authorization')}`);
      return String(url).endsWith('/complete')
        ? Response.json({ ...metadata, size: 3 })
        : Response.json({ ...metadata, size: 3, upload: direct() });
    },
  });
  try {
    const file = new File(['abc'], 'a.bin');
    await uploadPromptAttachment('p', file, { onProgress: (received) => progress.push(received) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ method: 'PUT', url: signedUrl, headers: directHeaders, body: file });
    expect(progress).toEqual([0, 1, 3]);
    expect(platform).toEqual([
      'POST https://api.test/projects/p/attachments Bearer token',
      'POST https://api.test/projects/p/attachments/attachment-1/complete Bearer token',
    ]);
  } finally {
    if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original);
    else delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  }
});

test('expired direct URL re-signs the same attachment_id before its single PUT', async () => {
  const calls: string[] = [];
  let resignBody: unknown;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (String(url).startsWith('https://storage.test/')) return Response.json({ Key: 'k' });
      if (String(url).endsWith('/complete')) return Response.json({ ...metadata, size: 3 });
      resignBody = JSON.parse(String(init?.body));
      return Response.json({ ...metadata, size: 3, upload: direct(freshUrl) });
    },
  });
  const resume: PromptAttachmentUpload = {
    ...metadata,
    size: 3,
    received_bytes: 0,
    upload: direct(signedUrl, '2000-01-01T00:00:00Z'),
  };
  expect(await uploadPromptAttachment('p', new File(['abc'], 'a.bin'), { resume })).toEqual({
    ...metadata,
    size: 3,
  });
  expect(resignBody).toEqual({
    attachment_id: 'attachment-1',
    filename: 'a.bin',
    mime: 'application/octet-stream',
    size: 3,
  });
  expect(calls).toEqual([
    'POST https://api.test/projects/p/attachments',
    `PUT ${freshUrl}`,
    'POST https://api.test/projects/p/attachments/attachment-1/complete',
  ]);
});

test('a rejected direct token re-signs once; an already stored object goes straight to completion', async () => {
  const calls: string[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (String(url) === signedUrl)
        return Response.json({ statusCode: '403', error: 'Unauthorized' }, { status: 400 });
      if (String(url) === freshUrl)
        return Response.json({ statusCode: '409', error: 'Duplicate' }, { status: 409 });
      if (String(url).endsWith('/complete')) return Response.json({ ...metadata, size: 3 });
      const body = JSON.parse(String(init?.body)) as { attachment_id?: string };
      return Response.json({
        ...metadata,
        size: 3,
        upload: direct(body.attachment_id ? freshUrl : signedUrl),
      });
    },
  });
  expect(await uploadPromptAttachment('p', new File(['abc'], 'a.bin'))).toEqual({
    ...metadata,
    size: 3,
  });
  expect(calls).toEqual([
    'POST https://api.test/projects/p/attachments',
    `PUT ${signedUrl}`,
    'POST https://api.test/projects/p/attachments',
    `PUT ${freshUrl}`,
    'POST https://api.test/projects/p/attachments/attachment-1/complete',
  ]);
});

test('direct PUT retries 503 and a network TypeError with the same URL and bytes', async () => {
  const puts: string[] = [];
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (String(url) === signedUrl) {
        puts.push(new TextDecoder().decode(await new Response(init?.body).arrayBuffer()));
        if (puts.length === 1) return Response.json({ error: 'busy' }, { status: 503 });
        if (puts.length === 2) throw new TypeError('network changed');
        return Response.json({ Key: 'k' });
      }
      return String(url).endsWith('/complete')
        ? Response.json({ ...metadata, size: 3 })
        : Response.json({ ...metadata, size: 3, upload: direct() });
    },
  });
  await uploadPromptAttachment('p', new File(['abc'], 'a.bin'));
  expect(puts).toEqual(['abc', 'abc', 'abc']);
}, 10_000);

test('a direct PUT that fails after 61 s of upload is retried: the budget starts at the failure', async () => {
  let clock = Date.now();
  const now = spyOn(Date, 'now').mockImplementation(() => clock);
  let puts = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url) => {
      if (String(url) === signedUrl) {
        puts++;
        if (puts === 1) {
          // A 50 MiB file on a slow uplink: the network changes 61 s into the PUT.
          clock += 61_000;
          throw new TypeError('network changed');
        }
        return Response.json({ Key: 'k' });
      }
      return String(url).endsWith('/complete')
        ? Response.json({ ...metadata, size: 3 })
        : Response.json({ ...metadata, size: 3, upload: direct() });
    },
  });
  try {
    expect(await uploadPromptAttachment('p', new File(['abc'], 'a.bin'))).toEqual({
      ...metadata,
      size: 3,
    });
    expect(puts).toBe(2);
  } finally {
    now.mockRestore();
  }
}, 10_000);

test('a stalled direct XHR upload is retried after its 60 s stall TIMEOUT', async () => {
  let clock = Date.now();
  const now = spyOn(Date, 'now').mockImplementation(() => clock);
  const timer = shortenTimers({ 60_000: 10 });
  let sends = 0;
  class StallingXMLHttpRequest {
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = '';
    open() {}
    setRequestHeader() {}
    send() {
      sends++;
      if (sends === 1) {
        // No progress event arrives; the stall timer fires 60 s later.
        clock += 60_001;
        return;
      }
      queueMicrotask(() => {
        this.status = 200;
        this.responseText = '{"Key":"k"}';
        this.onload?.();
      });
    }
    abort() {}
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: StallingXMLHttpRequest,
  });
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url) =>
      String(url).endsWith('/complete')
        ? Response.json({ ...metadata, size: 3 })
        : Response.json({ ...metadata, size: 3, upload: direct() }),
  });
  try {
    expect(await uploadPromptAttachment('p', new File(['abc'], 'a.bin'))).toEqual({
      ...metadata,
      size: 3,
    });
    expect(sends).toBe(2);
  } finally {
    timer.mockRestore();
    now.mockRestore();
    if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original);
    else delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  }
}, 10_000);

test('a transient begin failure retries and creates one upload', async () => {
  let begins = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url) => {
      if (String(url) === signedUrl) return Response.json({ Key: 'k' });
      if (String(url).endsWith('/complete')) return Response.json({ ...metadata, size: 3 });
      begins++;
      return begins === 1
        ? Response.json({ error: 'busy' }, { status: 503 })
        : Response.json({ ...metadata, size: 3, upload: direct() }, { status: 201 });
    },
  });
  expect(await uploadPromptAttachment('p', new File(['abc'], 'a.bin'))).toEqual({
    ...metadata,
    size: 3,
  });
  expect(begins).toBe(2);
}, 10_000);

test('begin refused by the attachment budget or by billing is not retried', async () => {
  const refusals = [
    {
      status: 429,
      body: { error: 'Unsent attachments are limited to 500 MiB.', code: 'attachment_budget_exceeded' },
    },
    { status: 402, body: { error: 'Out of credits', message: 'Out of credits' } },
  ];
  for (const { status, body } of refusals) {
    let begins = 0;
    configureKortix({
      backendUrl: 'https://api.test',
      getToken: async () => 'token',
      fetch: async () => {
        begins++;
        return Response.json(body, { status });
      },
    });
    await expect(uploadPromptAttachment('p', new File(['abc'], 'a.bin'))).rejects.toMatchObject({
      status,
    });
    expect(begins).toBe(1);
  }
});

test('abort is not retried: an aborted direct PUT sends exactly one request', async () => {
  let puts = 0;
  const abort = new AbortController();
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url) => {
      if (String(url) === signedUrl) {
        puts++;
        abort.abort();
        throw new DOMException('Aborted', 'AbortError');
      }
      return Response.json({ ...metadata, size: 3, upload: direct() });
    },
  });
  await expect(
    uploadPromptAttachment('p', new File(['abc'], 'a.bin'), { signal: abort.signal }),
  ).rejects.toMatchObject({ code: 'ABORTED' });
  expect(puts).toBe(1);
});

test('chunked handle with chunk_size 8 MiB uploads 10 MiB in exactly 2 PUTs', async () => {
  const size = 10 * MiB;
  const chunkSize = 8 * MiB;
  const calls: string[] = [];
  const progress: number[] = [];
  configureKortix({
    backendUrl: 'https://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
      if (init?.method === 'PUT') {
        const index = Number(String(url).split('/').at(-1));
        const bytes = (await new Response(init.body).arrayBuffer()).byteLength;
        expect(bytes).toBe(index === 0 ? chunkSize : size - chunkSize);
        return Response.json({ received_bytes: Math.min((index + 1) * chunkSize, size), size });
      }
      if (String(url).endsWith('/complete')) return Response.json({ ...metadata, size });
      return Response.json({ ...metadata, size, upload: chunked(chunkSize) });
    },
  });
  await uploadPromptAttachment('p', new File([new Uint8Array(size)], 'a.bin'), {
    onProgress: (received) => progress.push(received),
  });
  expect(calls).toEqual([
    'POST https://api.test/v1/projects/p/attachments',
    'PUT https://api.test/v1/projects/p/attachments/attachment-1/chunks/0',
    'PUT https://api.test/v1/projects/p/attachments/attachment-1/chunks/1',
    'POST https://api.test/v1/projects/p/attachments/attachment-1/complete',
  ]);
  expect(progress).toEqual([chunkSize, size]);
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
        String(url).endsWith('/complete') ? metadata : { ...metadata, upload: chunked() },
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

test('manual retry resumes a stored direct upload with completion only', async () => {
  let handle: PromptAttachmentUpload | undefined;
  let starts = 0,
    puts = 0,
    completes = 0;
  configureKortix({
    backendUrl: 'https://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url) => {
      if (String(url) === signedUrl) {
        puts++;
        return Response.json({ Key: 'k' });
      }
      if (String(url).endsWith('/complete')) {
        completes++;
        return completes === 1
          ? Response.json({ code: 'attachment_invalid', error: 'Invalid' }, { status: 409 })
          : Response.json(metadata);
      }
      starts++;
      return Response.json({ ...metadata, upload: direct() });
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
  expect({ starts, puts, completes }).toEqual({ starts: 1, puts: 1, completes: 2 });
});

test('completion retries typed server deadline and processing with the same ID', async () => {
  let completes = 0;
  configureKortix({
    backendUrl: 'https://api.test',
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
      resume: { ...metadata, upload: chunked(), received_bytes: metadata.size },
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
      return Response.json({ ...metadata, size: 3, upload: chunked() });
    },
  });
  await uploadPromptAttachment('p', new File(['abc'], 'a.bin'));
  expect(puts).toHaveLength(2);
  expect(puts[0]).toEqual(puts[1]);
});

test('chunk TIMEOUT is retried with the same index', async () => {
  const puts: string[] = [];
  const timer = shortenTimers({ 30_000: 1 });
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') {
        puts.push(String(url));
        return puts.length === 1
          ? new Promise<Response>(() => {})
          : Response.json({ received_bytes: 3, size: 3 });
      }
      return String(url).endsWith('/complete')
        ? Response.json({ ...metadata, size: 3 })
        : Response.json({ ...metadata, size: 3, upload: chunked() });
    },
  });
  try {
    await uploadPromptAttachment('p', new File(['abc'], 'a.bin'));
    expect(puts).toEqual([
      'https://api.test/projects/p/attachments/attachment-1/chunks/0',
      'https://api.test/projects/p/attachments/attachment-1/chunks/0',
    ]);
  } finally {
    timer.mockRestore();
  }
}, 10_000);

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
          : { ...metadata, upload: chunked() },
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

// A valid chunk_size above 64 KiB is covered by 'chunked handle with chunk_size 8 MiB uploads 10 MiB in exactly 2 PUTs'.
test('an invalid server chunk_size is refused before any byte is sent', async () => {
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => Response.json({ ...metadata, size: 3, upload: chunked(0) }),
  });
  await expect(uploadPromptAttachment('p', new File(['abc'], 'a.bin'))).rejects.toThrow(
    'Invalid attachment upload handle',
  );
});

test('caller cancellation during completion never retries and preserves the upload handle', async () => {
  let completes = 0;
  const abort = new AbortController();
  const resume = { ...metadata, size: 3, received_bytes: 3, upload: chunked() };
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

test('complete TIMEOUT is retried with the same attachment ID', async () => {
  let requests = 0;
  const timer = shortenTimers({ 120_000: 1 });
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url) => {
      expect(String(url)).toEndWith('/attachment-1/complete');
      requests++;
      return requests === 1 ? new Promise<Response>(() => {}) : Response.json(metadata);
    },
  });
  try {
    expect(
      await uploadPromptAttachment('p', new File(['abc'], 'a.bin'), {
        resume: { ...metadata, size: 3, received_bytes: 3, upload: chunked() },
      }),
    ).toEqual(metadata);
    expect(requests).toBe(2);
  } finally {
    timer.mockRestore();
  }
}, 10_000);

test('completion stops retrying five minutes after its first failure', async () => {
  const startedAt = Date.now();
  let requests = 0;
  // Each attempt takes just over five minutes. The budget starts at the first
  // failure, so one retry runs and the second failure ends the upload.
  const now = spyOn(Date, 'now').mockImplementation(() => startedAt + requests * 300_001);
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
        resume: { ...metadata, size: 3, received_bytes: 3, upload: chunked() },
      }),
    ).rejects.toMatchObject({ code: 'attachment_processing' });
    expect(requests).toBe(2);
  } finally {
    now.mockRestore();
  }
});

for (const status of [200, 503]) {
  test(`stalled completion response body (${status}) times out and retries the same ID`, async () => {
    let requests = 0;
    let bodyReads = 0;
    const timer = shortenTimers({ 120_000: 10 });
    configureKortix({
      backendUrl: 'https://api.test',
      getToken: async () => 'token',
      fetch: async () => {
        requests++;
        if (requests > 1) return Response.json(metadata);
        const response = Response.json({}, { status });
        response.json = () => {
          bodyReads++;
          return new Promise(() => {});
        };
        return response;
      },
    });
    try {
      expect(
        await uploadPromptAttachment('p', new File(['abc'], 'a.bin'), {
          resume: { ...metadata, size: 3, received_bytes: 3, upload: chunked() },
        }),
      ).toEqual(metadata);
      expect({ requests, bodyReads }).toEqual({ requests: 2, bodyReads: 1 });
    } finally {
      timer.mockRestore();
    }
  }, 10_000);
}
