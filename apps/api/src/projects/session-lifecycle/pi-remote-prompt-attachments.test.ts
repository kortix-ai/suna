import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { preparePiPromptAttachments } from './pi-prompt-attachments';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];
let responses: Response[] = [];
let addresses = [{ address: '93.184.216.34', family: 4 }];
mock.module('node:dns/promises', () => ({ lookup: async () => addresses }));
const remote = (url = 'https://images.example.test/capture.png?signature=private-value') => ({
  type: 'file' as const,
  mime: 'image/png',
  filename: 'capture.png',
  url,
});
const imageResponse = (bytes: Buffer = png, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png', ...headers } });

beforeEach(() => {
  calls = [];
  responses = [];
  addresses = [{ address: '93.184.216.34', family: 4 }];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return responses.shift() ?? imageResponse();
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const prepare = (parts = [remote()], signal?: AbortSignal) =>
  preparePiPromptAttachments(parts, { signal });

test('HTTPS images become private immutable bytes before prompt admission', async () => {
  const result = await prepare();
  const sha256 = createHash('sha256').update(png).digest('hex');
  expect(result.parts).toEqual([{ ...remote(), url: `kortix-attachment:sha256:${sha256}` }]);
  expect(result.attachments).toEqual([{ sha256, contentType: 'image/png', content: png }]);
  expect(JSON.stringify(result)).not.toContain('private-value');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.init?.redirect).toBe('manual');
  expect(new Headers(calls[0]?.init?.headers).has('authorization')).toBe(false);
  expect(new Headers(calls[0]?.init?.headers).has('cookie')).toBe(false);
});

test('duplicate URLs fetch once and preserve ordered filenames', async () => {
  const result = await prepare([remote(), { ...remote(), filename: 'second.png' }]);
  expect(calls).toHaveLength(1);
  expect(result.parts.map((part) => part.filename)).toEqual(['capture.png', 'second.png']);
  expect(result.attachments).toHaveLength(1);
});

test('all sibling metadata is checked before any external request', async () => {
  await expect(prepare([remote(), { ...remote(), filename: 'bad\0.png' }])).rejects.toThrow(
    /metadata/,
  );
  await expect(prepare(Array.from({ length: 17 }, () => remote()))).rejects.toThrow(/16 images/);
  expect(calls).toHaveLength(0);
});

test.each([
  'http://images.example.test/image.png',
  'https://127.0.0.1/image.png',
  'https://169.254.169.254/latest/meta-data',
  'https://[::1]/image.png',
  'https://user:password@images.example.test/image.png',
  'file:///workspace/private.png',
])('refuses unsafe remote image URL %s before fetching', async (url) => {
  await expect(prepare([remote(url)])).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test('a hostname resolving to a private address is refused', async () => {
  addresses = [{ address: '10.0.0.5', family: 4 }];
  await expect(prepare()).rejects.toThrow(/unsafe|public HTTPS/);
  expect(calls).toHaveLength(0);
});

test('redirects are revalidated without exposing a signed URL', async () => {
  responses.push(
    new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/secret' } }),
  );
  const error = await prepare().catch((error) => error as Error);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('expected image rejection');
  expect(error.message).not.toContain('private-value');
  expect(error.message).not.toContain('169.254');
  expect(calls).toHaveLength(1);
});

test('a public HTTPS redirect preserves the exact image bytes', async () => {
  responses.push(
    new Response(null, { status: 302, headers: { location: '/resolved.png' } }),
    imageResponse(),
  );
  expect((await prepare()).attachments[0]?.content).toEqual(png);
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    '/capture.png',
    '/resolved.png',
  ]);
});

test.each([
  () => new Response('upstream secret', { status: 403 }),
  () => imageResponse(png, { 'content-type': 'image/jpeg' }),
  () => imageResponse(Buffer.from('<html>login</html>')),
  () => imageResponse(Buffer.alloc(0)),
])('rejects remote errors and invalid image responses %#', async (response) => {
  responses.push(response());
  await expect(prepare()).rejects.toThrow(/remote image|image attachment/);
});

test.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])(
  'accepts supported remote image signature %s',
  async (mime) => {
    const signatures: Record<string, Buffer> = {
      'image/png': png,
      'image/jpeg': Buffer.from('ffd8ffe000104a464946', 'hex'),
      'image/gif': Buffer.from('GIF89a'),
      'image/webp': Buffer.from('RIFF0000WEBP'),
    };
    responses.push(imageResponse(signatures[mime], { 'content-type': mime }));
    const result = await prepare([{ ...remote(), mime }]);
    expect(result.attachments[0]?.content).toEqual(signatures[mime]);
    expect(result.attachments[0]?.contentType).toBe(mime);
  },
);

test('declared oversize bodies are cancelled without reading', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  responses.push(
    new Response(stream, {
      headers: { 'content-type': 'image/png', 'content-length': String(8 * 1024 * 1024 + 1) },
    }),
  );
  await expect(prepare()).rejects.toThrow(/8 MiB/);
  expect(cancelled).toBe(true);
});

test('chunked oversize bodies are cancelled when the byte limit is exceeded', async () => {
  let cancelled = false;
  let count = 0;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(count++ === 0 ? png : new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  responses.push(new Response(stream, { headers: { 'content-type': 'image/png' } }));
  await expect(prepare()).rejects.toThrow(/8 MiB/);
  expect(cancelled).toBe(true);
  expect(count).toBeLessThanOrEqual(11);
});

test('the total limit counts repeated image parts even when download is shared', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024);
  png.copy(bytes);
  responses.push(imageResponse(bytes));
  await expect(prepare([remote(), remote(), remote()])).rejects.toThrow(/16 MiB/);
  expect(calls).toHaveLength(1);
});

test('an aborted admission cancels a stalled response body', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let reads = 0;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        pull(stream) {
          if (reads++ === 0) stream.enqueue(png);
          else controller.abort();
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'image/png' } },
    )) as unknown as typeof fetch;
  await expect(prepare([remote()], controller.signal)).rejects.toThrow(/cancelled|timed out/);
  expect(cancelled).toBe(true);
  expect(reads).toBe(2);
});

test('transport errors never expose upstream response details or signed URLs', async () => {
  globalThis.fetch = (async () => {
    throw new Error('private-value upstream authorization secret');
  }) as unknown as typeof fetch;
  const error = await prepare().catch((error) => error as Error);
  if (!(error instanceof Error)) throw new Error('expected image rejection');
  expect(error.message).toBe('remote image download failed');
});
