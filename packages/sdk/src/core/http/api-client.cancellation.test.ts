import { afterEach, expect, test } from 'bun:test';
import { backendApi } from './api-client';
import { configureKortix } from './config';

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

test('raw PUT preserves bytes, auth and caller cancellation', async () => {
  const abort = new AbortController();
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const body = new Uint8Array([0, 255, 34, 10]);
  configureKortix({
    backendUrl: 'https://api.test/v1',
    getToken: async () => 'token',
    fetch: async (_url, init) => {
      expect(init?.body).toBe(body);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/octet-stream');
      started();
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        ),
      );
    },
  });
  const pending = backendApi.putRaw('/bytes', body, { signal: abort.signal });
  await start;
  abort.abort();
  expect((await pending).error?.code).toBe('ABORTED');
});

test('caller abort interrupts token hydration without sending a request', async () => {
  let requests = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => new Promise(() => {}),
    fetch: async () => {
      requests++;
      return Response.json({});
    },
  });
  const abort = new AbortController();
  const pending = backendApi.post('/upload', {}, { signal: abort.signal, timeout: 100 });
  abort.abort();
  expect((await pending).error?.code).toBe('ABORTED');
  expect(requests).toBe(0);
});

test('an already aborted caller never asks for a token or sends bytes', async () => {
  let tokens = 0;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => {
      tokens++;
      return 'token';
    },
  });
  const abort = new AbortController();
  abort.abort();
  expect((await backendApi.put('/bytes', {}, { signal: abort.signal })).error?.code).toBe(
    'ABORTED',
  );
  expect(tokens).toBe(0);
});

test('caller abort interrupts response parsing after headers arrive', async () => {
  let parsing!: () => void;
  const started = new Promise<void>((resolve) => {
    parsing = resolve;
  });
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => {
      const response = Response.json({});
      response.json = () => {
        parsing();
        return new Promise(() => {});
      };
      return response;
    },
  });
  const abort = new AbortController();
  const pending = backendApi.post('/complete', {}, { signal: abort.signal });
  await started;
  abort.abort();
  expect((await pending).error?.code).toBe('ABORTED');
});

test('stalled retryable read response body times out before another attempt', async () => {
  let requests = 0;
  const abort = new AbortController();
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async () => {
      requests++;
      const response = Response.json({}, { status: 503 });
      response.arrayBuffer = () => new Promise(() => {});
      return response;
    },
  });
  const pending = backendApi.get('/read', { signal: abort.signal, timeout: 10 });
  try {
    const observed = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve({ error: { code: 'STILL_PENDING' } }), 60)),
    ]);
    expect(observed).toMatchObject({ success: false, error: { code: 'TIMEOUT' } });
    expect(requests).toBe(1);
  } finally {
    abort.abort();
    // Cleanup must not make a response-body timeout regression hang the test runner.
  }
});
