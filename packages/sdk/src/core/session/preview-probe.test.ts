import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  PREVIEW_PROBE_TIMEOUT_MS,
  classifyPreviewProbeStatus,
  probePreviewPort,
} from './preview-probe';

const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; init: RequestInit }> = [];

function stubFetch(handler: (init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), init });
    return handler(init);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('classifyPreviewProbeStatus', () => {
  // The proxy answers 502/503/504 ITSELF when it could not open a connection to
  // the port — that is the one status family that means "nothing is listening".
  test.each([502, 503, 504])('%i means nothing is listening on the port', (status) => {
    expect(classifyPreviewProbeStatus(status)).toBe('unreachable');
  });

  // Any other HTTP answer proves a server accepted the connection and replied,
  // which is all "the port is up" means. A 404 or a 500 is the APP's answer.
  test.each([200, 204, 301, 404, 418, 500])('%i means something answered on the port', (status) => {
    expect(classifyPreviewProbeStatus(status)).toBe('reachable');
  });

  // 401/403 come from the preview proxy's own auth gate (an expired
  // `__preview_session` cookie), never from the app. They say nothing about the
  // port, so they must not be able to declare it dead.
  test.each([401, 403])('%i is our auth failing, not the port — unknown', (status) => {
    expect(classifyPreviewProbeStatus(status)).toBe('unknown');
  });

  test('a status we could not read (0) is unknown, never a verdict', () => {
    expect(classifyPreviewProbeStatus(0)).toBe('unknown');
  });

  test('a nonsense status is unknown, never a verdict', () => {
    expect(classifyPreviewProbeStatus(Number.NaN)).toBe('unknown');
    expect(classifyPreviewProbeStatus(-1)).toBe('unknown');
    expect(classifyPreviewProbeStatus(999)).toBe('unknown');
  });
});

describe('probePreviewPort', () => {
  test('issues a credentialed HEAD that never caches, so each probe re-asks the port', async () => {
    stubFetch(() => new Response(null, { status: 200 }));

    expect(await probePreviewPort('http://localhost:8008/v1/p/sbx1/3000/')).toBe('reachable');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://localhost:8008/v1/p/sbx1/3000/');
    expect(requests[0].init.method).toBe('HEAD');
    // The `__preview_session` cookie is the preview proxy's auth. Without it
    // every probe would 401 and never reach a verdict.
    expect(requests[0].init.credentials).toBe('include');
    expect(requests[0].init.cache).toBe('no-store');
    // No Authorization header on purpose: a non-safelisted header would turn
    // this simple request into a CORS preflight.
    expect(requests[0].init.headers).toBeUndefined();
  });

  test('reports a proxy 502 as unreachable', async () => {
    stubFetch(() => new Response('{"error":"port not reachable"}', { status: 502 }));
    expect(await probePreviewPort('http://localhost:8008/v1/p/sbx1/3000/')).toBe('unreachable');
  });

  test('reports an app 404 as reachable — the app answered', async () => {
    stubFetch(() => new Response(null, { status: 404 }));
    expect(await probePreviewPort('http://localhost:8008/v1/p/sbx1/3000/')).toBe('reachable');
  });

  // A rejected fetch is a CORS refusal, an offline browser, or a dropped
  // connection. None of those is evidence about the port.
  test('a rejected fetch is unknown, not a failure verdict', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await probePreviewPort('http://localhost:8008/v1/p/sbx1/3000/')).toBe('unknown');
  });

  test('returns unknown without issuing a request when there is no url', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    expect(await probePreviewPort('')).toBe('unknown');
    expect(requests).toHaveLength(0);
  });

  test('times out into unknown rather than hanging on a stalled port', async () => {
    stubFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    expect(await probePreviewPort('http://localhost:8008/v1/p/sbx1/3000/', { timeoutMs: 5 })).toBe(
      'unknown',
    );
  });

  test('an already-aborted caller signal short-circuits to unknown', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    const controller = new AbortController();
    controller.abort();

    expect(
      await probePreviewPort('http://localhost:8008/v1/p/sbx1/3000/', {
        signal: controller.signal,
      }),
    ).toBe('unknown');
    expect(requests).toHaveLength(0);
  });

  test('the default timeout is bounded', () => {
    expect(PREVIEW_PROBE_TIMEOUT_MS).toBe(10_000);
  });
});
