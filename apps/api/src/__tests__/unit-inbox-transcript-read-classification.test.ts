import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The inbox transcript read fails open, and its log level follows the cause:
 * an expected stopped/gone/cold runtime state logs info ("deferred"), an
 * unexpected failure keeps its warn ("failed"). Warning on the expected states
 * was the spike KRTX-2349 files: `platinum … expose -> 409` (Platinum
 * auto-stops idle boxes) and `The operation timed out.` dominated its 156
 * warn lines in two days. The classification is `isRuntimeUnavailableError`
 * — the same one the transcript capture uses — asserted here through the
 * catch itself, not through a copy of the rule.
 */
const SESSION_ID = 'sess-inbox-classify-1';
const OC_SESSION_ID = 'oc-inbox-classify-1';

const infoLines: Array<[string, unknown]> = [];
const warnLines: Array<[string, unknown]> = [];

mock.module('../config', () => ({
  config: { KORTIX_URL: 'https://api.test' },
  SANDBOX_VERSION: 'test',
}));

mock.module('../lib/logger', () => ({
  logger: {
    info: (message: string, context?: unknown) => infoLines.push([message, context]),
    warn: (message: string, context?: unknown) => warnLines.push([message, context]),
    error: () => undefined,
    debug: () => undefined,
  },
}));

mock.module('../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              opencodeSessionId: OC_SESSION_ID,
              sandboxUrl: 'https://box.test/p/ext-inbox-classify/8000/',
              accountId: 'acct-1',
              projectId: 'proj-1',
              createdBy: 'user-1',
            },
          ],
        }),
      }),
    }),
  },
}));

const realOpencodeMapping = await import('../projects/opencode-mapping');
mock.module('../projects/opencode-mapping', () => ({
  ...realOpencodeMapping,
  sandboxOpencodeEndpoint: async () => ({
    url: 'https://box.test/p/ext-inbox-classify/8000',
    headers: { 'x-kortix': '1' },
  }),
}));

import { PlatinumHttpError } from '../shared/platinum';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

const row = { commandId: 'cmd-1', sessionId: SESSION_ID, actorUserId: null } as never;

async function readWithFetchThrowing(throwable: () => unknown) {
  globalThis.fetch = (async () => {
    throw throwable();
  }) as unknown as typeof fetch;
  const { readInboxTranscriptState } = await import('../projects/session-lifecycle/runtime-client');
  return readInboxTranscriptState(row, []);
}

describe('readInboxTranscriptState: the log level follows the cause', () => {
  beforeAll(() => {
    console.warn = ((message?: unknown, ...rest: unknown[]) => {
      warnLines.push([String(message), rest[0]]);
    }) as typeof console.warn;
  });
  beforeEach(() => {
    infoLines.length = 0;
    warnLines.length = 0;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  test('a stopped box (the provider 409 expose answer) logs info, not warn', async () => {
    const state = await readWithFetchThrowing(
      () => new PlatinumHttpError('platinum POST /v1/sandboxes/sbx_x/expose -> 409', 409, '{"code":"sandbox_not_running"}'),
    );
    // Fails open either way — the assertion is about the LEVEL.
    expect(state.read).toBe(false);
    expect(infoLines.some(([m]) => m.includes('inbox transcript read deferred'))).toBe(true);
    expect(warnLines.some(([m]) => m.includes('inbox transcript read failed'))).toBe(false);
  });

  test('a read that overruns its budget logs info, not warn', async () => {
    const timeout = new Error('The operation timed out.');
    timeout.name = 'TimeoutError';
    await readWithFetchThrowing(() => timeout);
    expect(infoLines.some(([m]) => m.includes('inbox transcript read deferred'))).toBe(true);
    expect(warnLines.some(([m]) => m.includes('inbox transcript read failed'))).toBe(false);
  });

  test('a database failure keeps its warn', async () => {
    infoLines.length = 0;
    await readWithFetchThrowing(() => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
    expect(warnLines.some(([m]) => m.includes('inbox transcript read failed'))).toBe(true);
    expect(infoLines.some(([m]) => m.includes('inbox transcript read deferred'))).toBe(false);
  });
});
