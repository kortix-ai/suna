import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'kortix-platinum-reliability-test-'));
const tarPath = join(fixtureRoot, 'context.tar.gz');
writeFileSync(tarPath, 'fake-build-context-bytes');

type Tpl = { id: string; name?: string; state?: string };

let listResponse: Tpl[] = [];
let byIdResponses: Record<string, Tpl> = {};
let listCalls = 0;
let byIdCalls: Record<string, number> = {};
let byIdErrorOverride: Record<string, string> = {};

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJson: async (path: string) => {
    if (path === '/v1/templates') {
      listCalls++;
      return listResponse;
    }
    const idMatch = path.match(/^\/v1\/templates\/([^/]+)$/);
    if (idMatch) {
      const id = idMatch[1];
      byIdCalls[id] = (byIdCalls[id] ?? 0) + 1;
      if (byIdErrorOverride[id]) throw new Error(byIdErrorOverride[id]);
      const tpl = byIdResponses[id];
      if (!tpl) throw new Error(`platinum GET ${path} -> 404 {"error":"template not found"}`);
      return tpl;
    }
    throw new Error(`unexpected Platinum path: ${path}`);
  },
}));

const { waitForActive, uploadWithRetry } = await import('./platinum');

beforeEach(() => {
  listResponse = [];
  byIdResponses = {};
  listCalls = 0;
  byIdCalls = {};
  byIdErrorOverride = {};
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('waitForActive', () => {
  test('resolves via GET /:id even when the (truncated) name-list would not contain the template', async () => {
    const id = 'tpl-primary';
    listResponse = [];
    byIdResponses = { [id]: { id, name: 'kortix-hidden', state: 'ready' } };

    await expect(waitForActive('kortix-hidden', undefined, id)).resolves.toBeUndefined();

    expect(byIdCalls[id]).toBeGreaterThanOrEqual(1);
    expect(listCalls).toBe(0);
  });

  test('falls back to the name-list lookup when no id is available', async () => {
    listResponse = [{ id: 'tpl-legacy', name: 'kortix-legacy', state: 'ready' }];
    byIdResponses = {};

    await expect(waitForActive('kortix-legacy', undefined, undefined)).resolves.toBeUndefined();

    expect(listCalls).toBeGreaterThanOrEqual(1);
    expect(byIdCalls).toEqual({});
  });

  test('treats a transient 404 on GET /:id as "not ready yet", not a hard failure', async () => {
    const id = 'tpl-lagging';
    byIdResponses = {};
    listResponse = [];

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      byIdResponses = { [id]: { id, name: 'kortix-lagging', state: 'ready' } };
      fn();
    }) as unknown as typeof setTimeout;

    try {
      await expect(waitForActive('kortix-lagging', undefined, id)).resolves.toBeUndefined();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(byIdCalls[id]).toBeGreaterThanOrEqual(2);
  });

  test('terminates immediately on state "failed" via GET /:id — not just "ready"', async () => {
    const id = 'tpl-failed';
    byIdResponses = { [id]: { id, name: 'kortix-failed', state: 'failed' } };

    await expect(waitForActive('kortix-failed', undefined, id)).rejects.toThrow(
      /Platinum template kortix-failed build failed/,
    );
    expect(byIdCalls[id]).toBe(1);
  });

  test('terminates on state "failed" via the name-list fallback path too (no id)', async () => {
    listResponse = [{ id: 'tpl-failed-list', name: 'kortix-failed-list', state: 'failed' }];

    await expect(waitForActive('kortix-failed-list', undefined, undefined)).rejects.toThrow(
      /Platinum template kortix-failed-list build failed/,
    );
    expect(listCalls).toBe(1);
  });

  test('honors the deadline and does NOT spin forever on a persistent non-404 error (e.g. a 500)', async () => {
    const id = 'tpl-stuck-500';
    byIdErrorOverride = {
      [id]: 'platinum GET /v1/templates/tpl-stuck-500 -> 500 {"error":"internal"}',
    };

    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    let simulatedNow = originalDateNow();
    Date.now = (() => simulatedNow) as typeof Date.now;
    globalThis.setTimeout = ((fn: () => void) => {
      simulatedNow += 5 * 60 * 1000;
      fn();
    }) as unknown as typeof setTimeout;

    try {
      await expect(waitForActive('kortix-stuck', undefined, id)).rejects.toThrow(
        /did not become ready \(last state: missing\)/,
      );
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(byIdCalls[id]).toBeGreaterThan(0);
    expect(byIdCalls[id]).toBeLessThan(10);
  });
});

describe('uploadWithRetry', () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  test('re-presigns and succeeds on the 2nd attempt after a first 408', async () => {
    globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

    let putCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        putCalls++;
        return putCalls === 1
          ? new Response('idle timeout', { status: 408 })
          : new Response('', { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    const presignedKeys: string[] = [];
    const presignFn = mock(async () => {
      const key = `ctx-key-${presignedKeys.length + 1}`;
      presignedKeys.push(key);
      return { upload_url: `https://upload.test/${key}`, context_s3_key: key };
    });

    const winningKey = await uploadWithRetry(presignFn, tarPath);

    expect(winningKey).toBe('ctx-key-2');
    expect(presignFn).toHaveBeenCalledTimes(2);
    expect(putCalls).toBe(2);
  });

  test('throws a clear error after 3 failed attempts', async () => {
    globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

    let putCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        putCalls++;
        return new Response('idle timeout', { status: 408 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    const presignedKeys: string[] = [];
    const presignFn = mock(async () => {
      const key = `ctx-key-${presignedKeys.length + 1}`;
      presignedKeys.push(key);
      return { upload_url: `https://upload.test/${key}`, context_s3_key: key };
    });

    await expect(uploadWithRetry(presignFn, tarPath)).rejects.toThrow(/3\/3 attempt/);
    expect(presignFn).toHaveBeenCalledTimes(3);
    expect(putCalls).toBe(3);
  });

  test('a 413 (non-retryable) throws immediately WITHOUT a re-presign', async () => {
    globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

    let putCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        putCalls++;
        return new Response('payload too large', { status: 413 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    const presignFn = mock(async () => ({ upload_url: 'https://upload.test/ctx-key-1', context_s3_key: 'ctx-key-1' }));

    await expect(uploadWithRetry(presignFn, tarPath)).rejects.toThrow(/failed after 1\/3 attempt/);
    expect(presignFn).toHaveBeenCalledTimes(1);
    expect(putCalls).toBe(1);
  });

  test('a 500 fails once then succeeds on the 2nd attempt (fresh presign)', async () => {
    globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

    let putCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        putCalls++;
        return putCalls === 1
          ? new Response('internal error', { status: 500 })
          : new Response('', { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    const presignedKeys: string[] = [];
    const presignFn = mock(async () => {
      const key = `ctx-key-${presignedKeys.length + 1}`;
      presignedKeys.push(key);
      return { upload_url: `https://upload.test/${key}`, context_s3_key: key };
    });

    const winningKey = await uploadWithRetry(presignFn, tarPath);
    expect(winningKey).toBe('ctx-key-2');
    expect(presignFn).toHaveBeenCalledTimes(2);
    expect(putCalls).toBe(2);
  });

  test('a TimeoutError (our own AbortSignal firing) fails once then succeeds on retry', async () => {
    globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

    let putCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        putCalls++;
        if (putCalls === 1) {
          throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
        }
        return new Response('', { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    const presignedKeys: string[] = [];
    const presignFn = mock(async () => {
      const key = `ctx-key-${presignedKeys.length + 1}`;
      presignedKeys.push(key);
      return { upload_url: `https://upload.test/${key}`, context_s3_key: key };
    });

    const winningKey = await uploadWithRetry(presignFn, tarPath);
    expect(winningKey).toBe('ctx-key-2');
    expect(presignFn).toHaveBeenCalledTimes(2);
    expect(putCalls).toBe(2);
  });

  test('all 3 attempts failing with heterogeneous retryable errors (500, TimeoutError, 500) still throws with the correct attempt count', async () => {
    globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

    let putCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        putCalls++;
        if (putCalls === 2) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        return new Response('internal error', { status: 500 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    const presignFn = mock(async () => ({ upload_url: 'https://upload.test/x', context_s3_key: 'k' }));

    await expect(uploadWithRetry(presignFn, tarPath)).rejects.toThrow(/failed after 3\/3 attempt/);
    expect(presignFn).toHaveBeenCalledTimes(3);
    expect(putCalls).toBe(3);
  });

  describe('status-extraction regex robustness', () => {
    test('a non-retryable status is NOT "rescued" by a stray 3-digit number embedded in the response body', async () => {
      globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

      let putCalls = 0;
      globalThis.fetch = Object.assign(
        async () => {
          putCalls++;
          return new Response('payload too large (upstream node-500 rejected it)', { status: 413 });
        },
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch;

      const presignFn = mock(async () => ({ upload_url: 'https://upload.test/x', context_s3_key: 'k' }));

      await expect(uploadWithRetry(presignFn, tarPath)).rejects.toThrow(/failed after 1\/3 attempt/);
      expect(presignFn).toHaveBeenCalledTimes(1);
      expect(putCalls).toBe(1);
    });

    test('a retryable 5xx is recognized even when the body text contains an unrelated non-5xx 3-digit number', async () => {
      globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

      let putCalls = 0;
      globalThis.fetch = Object.assign(
        async () => {
          putCalls++;
          return putCalls === 1
            ? new Response('upstream said 404 to a different downstream request', { status: 500 })
            : new Response('', { status: 200 });
        },
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch;

      const presignFn = mock(async () => ({ upload_url: 'https://upload.test/x', context_s3_key: 'k' }));

      await expect(uploadWithRetry(presignFn, tarPath)).resolves.toBe('k');
      expect(putCalls).toBe(2);
      expect(presignFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('presign-call failures (regression: presignFn used to bypass the retry loop entirely)', () => {
    test('a transient (retryable) presign failure is retried, not thrown immediately', async () => {
      globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

      globalThis.fetch = Object.assign(
        async () => new Response('', { status: 200 }),
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch;

      let presignCalls = 0;
      const presignFn = mock(async () => {
        presignCalls++;
        if (presignCalls === 1) {
          throw new Error('platinum POST /v1/templates/from-build/presign -> 500 {"error":"internal"}');
        }
        return { upload_url: 'https://upload.test/ctx-key-2', context_s3_key: 'ctx-key-2' };
      });

      const winningKey = await uploadWithRetry(presignFn, tarPath);
      expect(winningKey).toBe('ctx-key-2');
      expect(presignFn).toHaveBeenCalledTimes(2);
    });

    test('a non-retryable presign failure (e.g. 401) still throws immediately after exactly 1 attempt', async () => {
      globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;
      globalThis.fetch = Object.assign(
        async () => new Response('', { status: 200 }),
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch;

      const presignFn = mock(async () => {
        throw new Error('platinum POST /v1/templates/from-build/presign -> 401 {"error":"unauthorized"}');
      });

      await expect(uploadWithRetry(presignFn, tarPath)).rejects.toThrow(/failed after 1\/3 attempt/);
      expect(presignFn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('uploadWithRetry signal hygiene (no double-abort / reused-signal across retries)', () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  test('each attempt gets its own fresh AbortSignal — a 2nd attempt actually runs after the 1st one fails/aborts, unaffected by it', async () => {
    globalThis.setTimeout = ((fn: () => void) => fn()) as unknown as typeof setTimeout;

    const seenSignals: (AbortSignal | undefined)[] = [];
    let putCalls = 0;
    globalThis.fetch = Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        putCalls++;
        seenSignals.push(init?.signal ?? undefined);
        if (putCalls === 1) {
          throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
        }
        return new Response('', { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    const presignFn = mock(async () => ({ upload_url: 'https://upload.test/x', context_s3_key: 'k' }));

    const winningKey = await uploadWithRetry(presignFn, tarPath);
    expect(winningKey).toBe('k');
    expect(putCalls).toBe(2);
    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBeDefined();
    expect(seenSignals[1]).toBeDefined();
    expect(seenSignals[0]).not.toBe(seenSignals[1]);
    expect(seenSignals[1]!.aborted).toBe(false);
  });
});
