import { describe, expect, test, beforeEach, mock } from 'bun:test';

let promptImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });

// Overridable per-test so "Server URL not ready" (getClient() throwing before
// the runtime url is pinned) can be simulated N times before it starts
// resolving — mirrors the real client's throw during the sandbox-loading
// window (see opencode/client.ts).
let getClientImpl: () => { session: { promptAsync: (args: unknown) => Promise<unknown> } } = () => ({
  session: { promptAsync: (args: unknown) => promptImpl(args) },
});

mock.module('../../core/runtime/client', () => ({
  getClient: () => getClientImpl(),
}));

mock.module('../../core/http/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import {
  extractSendErrorMessage,
  getSendRetryDelayMs,
  isRuntimeNotReadyError,
  isTransientSendStatus,
  promptRuntimeMessage,
} from './messages';

beforeEach(() => {
  promptImpl = async () => ({ data: {} });
  getClientImpl = () => ({ session: { promptAsync: (args: unknown) => promptImpl(args) } });
});

describe('promptRuntimeMessage', () => {
  test('resolves on a successful prompt (via the async/fire-and-forget endpoint)', async () => {
    let captured: unknown;
    promptImpl = async (args) => {
      captured = args;
      return { data: {} };
    };

    await expect(
      promptRuntimeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toBeUndefined();
    expect(captured).toMatchObject({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });
  });

  test('passes directory through to the wire payload when provided', async () => {
    let captured: unknown;
    promptImpl = async (args) => {
      captured = args;
      return { data: {} };
    };

    await promptRuntimeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
      options: { directory: '/workspace/project' },
    });
    expect(captured).toMatchObject({ directory: '/workspace/project' });
  });

  test('a 402 response throws immediately (not retryable) with the status for billing classification', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      return {
        error: { data: { message: 'Insufficient credits. Balance: $-0.06' } },
        response: new Response(null, { status: 402 }),
      };
    };

    const err = await promptRuntimeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).status).toBe(402);
    expect((err as any).response).toEqual({ status: 402 });
    expect((err as Error).message).toBe('Insufficient credits. Balance: $-0.06');
  });

  test('a real 4xx client error is preserved and never retried', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      return {
        error: { message: 'agent crashed' },
        response: new Response(null, { status: 422 }),
      };
    };

    const err = await promptRuntimeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(calls).toBe(1);
    expect((err as Error).message).toBe('agent crashed');
    expect((err as any).status).toBe(422);
  });

  test('retries a transient 5xx and resolves once the server recovers', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      if (calls < 3) {
        return { error: { message: 'upstream blip' }, response: new Response(null, { status: 502 }) };
      }
      return { data: {} };
    };

    await expect(
      promptRuntimeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  test('exhausts the transient retry window and throws the final error', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      return { error: { message: 'upstream blip' }, response: new Response(null, { status: 502 }) };
    };

    const err = await promptRuntimeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    // TRANSIENT_BACKOFF_MS has 3 entries → 4 total attempts before giving up.
    expect(calls).toBe(4);
    expect((err as Error).message).toBe('upstream blip');
  });

  test('retries a thrown transport error and eventually rejects', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      throw new Error('Failed to fetch');
    };

    const err = await promptRuntimeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(calls).toBe(4);
    expect((err as Error).message).toBe('Failed to fetch');
  });

  test('getClient() throwing "Server URL not ready" a few times still lands the send within the boot window', async () => {
    // Regression: getClient() used to be resolved ONCE before the retry loop,
    // so this throw propagated instantly with zero retries and permanently
    // dropped the first prompt of a brand-new session (the runtime url isn't
    // pinned yet). It must now be resolved INSIDE the loop and get the same
    // boot-window retry treatment as the sandbox proxy's 503.
    let getClientCalls = 0;
    getClientImpl = () => {
      getClientCalls++;
      if (getClientCalls < 3) {
        throw new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
      }
      return { session: { promptAsync: (args: unknown) => promptImpl(args) } };
    };
    let promptCalls = 0;
    promptImpl = async () => {
      promptCalls++;
      return { data: {} };
    };

    await expect(
      promptRuntimeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toBeUndefined();

    expect(getClientCalls).toBe(3);
    expect(promptCalls).toBe(1);
  });

  test('getClient() never becoming ready exhausts the boot window and throws', async () => {
    let getClientCalls = 0;
    getClientImpl = () => {
      getClientCalls++;
      throw new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
    };

    // The full boot window is ~29s of real backoff (see BOOT_BACKOFF_MS) —
    // collapse the waits to fire immediately so this test exercises the
    // "never recovers" exhaustion path without blocking the suite for half a
    // minute; the attempt-count/classification logic under test is unaffected.
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: unknown[]) => void,
    ) => realSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      const err = await promptRuntimeMessage({
        sessionId: 'sess-1',
        parts: [{ type: 'text', text: 'hi' }],
      }).then(
        () => undefined,
        (e) => e,
      );

      // BOOT_BACKOFF_MS has 10 entries → 11 total attempts before giving up.
      expect(getClientCalls).toBe(11);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Server URL not ready');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('extractSendErrorMessage', () => {
  test('reads thrown Error messages', () => {
    expect(extractSendErrorMessage(new Error('opencode not ready'))).toBe('opencode not ready');
  });

  test('reads plain strings', () => {
    expect(extractSendErrorMessage('opencode not ready')).toBe('opencode not ready');
  });

  test('reads the SDK response-error shape ({ data: { message } })', () => {
    expect(extractSendErrorMessage({ data: { message: 'opencode not ready' } })).toBe(
      'opencode not ready',
    );
  });

  test('reads a top-level message / error field', () => {
    expect(extractSendErrorMessage({ message: 'boom' })).toBe('boom');
    expect(extractSendErrorMessage({ error: 'nope' })).toBe('nope');
  });

  test('returns empty string for nullish input', () => {
    expect(extractSendErrorMessage(null)).toBe('');
    expect(extractSendErrorMessage(undefined)).toBe('');
  });
});

describe('isRuntimeNotReadyError', () => {
  test('matches the boot 503 across shapes and casing', () => {
    expect(isRuntimeNotReadyError(new Error('opencode not ready'))).toBe(true);
    expect(isRuntimeNotReadyError('Runtime Not Ready')).toBe(true);
    expect(isRuntimeNotReadyError({ data: { message: 'opencode not ready' } })).toBe(true);
    expect(isRuntimeNotReadyError('Failed to perform action: opencode not ready')).toBe(true);
  });

  test('does not match unrelated errors', () => {
    expect(isRuntimeNotReadyError(new Error('Insufficient credits'))).toBe(false);
    expect(isRuntimeNotReadyError({ data: { message: 'Bad request' } })).toBe(false);
    expect(isRuntimeNotReadyError(null)).toBe(false);
  });
});

describe('isTransientSendStatus', () => {
  test('treats missing status (thrown transport error) as transient', () => {
    expect(isTransientSendStatus(undefined)).toBe(true);
  });

  test('treats 5xx / 408 / 429 as transient', () => {
    expect(isTransientSendStatus(500)).toBe(true);
    expect(isTransientSendStatus(503)).toBe(true);
    expect(isTransientSendStatus(408)).toBe(true);
    expect(isTransientSendStatus(429)).toBe(true);
  });

  test('treats other 4xx as terminal', () => {
    expect(isTransientSendStatus(400)).toBe(false);
    expect(isTransientSendStatus(401)).toBe(false);
    expect(isTransientSendStatus(404)).toBe(false);
  });
});

describe('getSendRetryDelayMs', () => {
  test('retries "opencode not ready" across the full boot window', () => {
    const err = new Error('opencode not ready');
    // 503 status is reported alongside the boot message.
    const delays: number[] = [];
    for (let attempt = 1; ; attempt++) {
      const delay = getSendRetryDelayMs(attempt, 503, err);
      if (delay === null) break;
      delays.push(delay);
      if (attempt > 20) throw new Error('retry schedule did not terminate');
    }
    // 10 retries → 11 total attempts, covering ~29s of cold boot / wake.
    expect(delays.length).toBe(10);
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(25000);
  });

  test('any 503 uses the boot/wake window even without a tidy message', () => {
    // A 503 from the sandbox proxy always means "not ready / waking", so it must
    // get the long boot window — not the short transient one — so a wake-from-
    // auto-stop send lands instead of reverting a prompt that then runs.
    const opaque = {}; // SDK error whose body didn't carry a message
    const delays: number[] = [];
    for (let attempt = 1; ; attempt++) {
      const delay = getSendRetryDelayMs(attempt, 503, opaque);
      if (delay === null) break;
      delays.push(delay);
      if (attempt > 20) throw new Error('retry schedule did not terminate');
    }
    expect(delays.length).toBe(10);
  });

  test('retries a generic transient 5xx, but only briefly', () => {
    const err = { data: { message: 'upstream blip' } };
    expect(getSendRetryDelayMs(1, 502, err)).toBe(400);
    expect(getSendRetryDelayMs(2, 502, err)).toBe(1000);
    expect(getSendRetryDelayMs(3, 502, err)).toBe(2000);
    // Generic transient window (a non-503 5xx) exhausts after 3 retries.
    expect(getSendRetryDelayMs(4, 502, err)).toBeNull();
  });

  test('retries a thrown transport error (no status)', () => {
    const err = new Error('Failed to fetch');
    expect(getSendRetryDelayMs(1, undefined, err)).toBe(400);
    expect(getSendRetryDelayMs(3, undefined, err)).toBe(2000);
    expect(getSendRetryDelayMs(4, undefined, err)).toBeNull();
  });

  test('never retries a real 4xx client error', () => {
    const err = { data: { message: 'Bad request' } };
    expect(getSendRetryDelayMs(1, 400, err)).toBeNull();
    expect(getSendRetryDelayMs(1, 401, err)).toBeNull();
    expect(getSendRetryDelayMs(1, 404, err)).toBeNull();
  });

  test('"opencode not ready" wins even when surfaced as a non-transient status', () => {
    // Defensive: if the boot 503 is ever relabeled with a 4xx-ish status, the
    // message still drives a boot-window retry.
    const err = new Error('opencode not ready');
    expect(getSendRetryDelayMs(1, 400, err)).toBe(400);
  });
});
