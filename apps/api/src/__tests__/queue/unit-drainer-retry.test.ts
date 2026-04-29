/**
 * Unit tests for queue-drainer retry + dead-letter logic.
 *
 * Strategy:
 * - Use a temp directory so storage reads/writes real JSON files (no mock needed).
 * - Mock global fetch: session status → idle; sendPrompt → always fail for
 *   message 1, succeed for message 2.
 * - Exercise drainOnce() directly (now exported for testing).
 * - Assert dead-letter after MAX_RETRIES (5) + subsequent messages unblocked.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Stub config to prevent env validation errors
mock.module('../../config', () => ({
  config: {
    OPENCODE_URL: 'http://localhost:14000',
    KORTIX_MASTER_URL: undefined,
    SANDBOX_PORT_BASE: 14000,
    INTERNAL_SERVICE_KEY: undefined,
  },
}));

// ─── Temp dir for queue storage ───────────────────────────────────────────────

let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'drainer-test-'));
  process.env.KORTIX_DATA_DIR = tmpDir;
  process.env.OPENCODE_URL = 'http://localhost:14000';
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KORTIX_DATA_DIR;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SESSION_ID = 'test-session-drainer';

// Build a fetch mock: session status = idle, sendPrompt = configurable
function makeFetch(sendSucceeds: (url: string) => boolean): typeof fetch {
  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

    // Session status endpoint → idle
    if (url.includes(`/session/${SESSION_ID}`) && !url.includes('prompt_async')) {
      return new Response(JSON.stringify({ id: SESSION_ID, status: { type: 'idle' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // prompt_async endpoint
    if (url.includes('prompt_async')) {
      if (sendSucceeds(url)) {
        return new Response('', { status: 204 });
      }
      return new Response('error', { status: 503 });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('queue-drainer retry + dead-letter', () => {
  test('dead-letters message after 5 failed send attempts', async () => {
    // Cache-bust so the module re-reads KORTIX_DATA_DIR and OPENCODE_URL
    const cb = `?t=${Date.now()}`;
    const { drainOnce } = await import(`../../queue/drainer.ts${cb}`);
    const { enqueue, getSessionQueue } = await import(`../../queue/storage.ts${cb}`);

    // Enqueue one message
    enqueue(SESSION_ID, 'hello world');
    expect(getSessionQueue(SESSION_ID).length).toBe(1);

    // Always fail
    globalThis.fetch = makeFetch(() => false) as typeof fetch;

    // Drain 5 times — each attempt re-queues with incremented retryCount
    // but nextRetryAt will be in the past so we pin Date.now to 0 in the mock.
    // Instead of time-travel, set nextRetryAt to 0 so each drain triggers.
    // The drainer sets nextRetryAt = Date.now() + 2^n * 2000 — in tests this
    // means we'd need to wait. Easier: override Date.now to a far-future value
    // after the first drain so backoff is bypassed.
    // Override Date.now so nextRetryAt backoff is always bypassed:
    // drainOnce checks `Date.now() < msg.nextRetryAt` — if Date.now returns
    // Infinity then the condition is never true (Infinity < anything is false).
    const realDateNow = Date.now;
    Date.now = () => Infinity as unknown as number;

    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        await drainOnce();
      }
    } finally {
      Date.now = realDateNow;
    }

    // After 5 failures, message should be dead-lettered (dropped from queue)
    const remaining = getSessionQueue(SESSION_ID);
    expect(remaining.length).toBe(0);
  });

  test('subsequent messages are unblocked after dead-letter', async () => {
    const cb = `?t=${Date.now() + 1}`;
    const { drainOnce } = await import(`../../queue/drainer.ts${cb}`);
    const { enqueue, getSessionQueue } = await import(`../../queue/storage.ts${cb}`);

    // Enqueue 2 messages
    enqueue(SESSION_ID, 'msg-fail');
    enqueue(SESSION_ID, 'msg-succeed');
    expect(getSessionQueue(SESSION_ID).length).toBe(2);

    const sentUrls: string[] = [];

    // First message always fails; second always succeeds
    globalThis.fetch = makeFetch((url) => {
      // Track prompt_async calls
      if (url.includes('prompt_async')) sentUrls.push(url);
      // No way to distinguish which message in URL — we track send count instead
      return sentUrls.filter((u) => u.includes('prompt_async')).length > 5;
    }) as typeof fetch;

    const realDateNow = Date.now;
    Date.now = () => Infinity as unknown as number;
    // Run 6 times: 5 to dead-letter msg-fail, 1 to send msg-succeed
    try {
      for (let i = 0; i < 6; i++) {
        await drainOnce();
      }
    } finally {
      Date.now = realDateNow;
    }

    // Both messages should be gone: msg-fail dead-lettered, msg-succeed sent
    const remaining = getSessionQueue(SESSION_ID);
    expect(remaining.length).toBe(0);
    // prompt_async called at least 6 times (5 for msg-fail, 1+ for msg-succeed)
    expect(sentUrls.length).toBeGreaterThanOrEqual(6);
  });

  test('retried message has retryCount incremented and nextRetryAt set', async () => {
    const cb = `?t=${Date.now() + 2}`;
    const { drainOnce } = await import(`../../queue/drainer.ts${cb}`);
    const { enqueue, getSessionQueue } = await import(`../../queue/storage.ts${cb}`);

    enqueue(SESSION_ID, 'msg-retry');

    // Always fail
    globalThis.fetch = makeFetch(() => false) as typeof fetch;

    await drainOnce();

    const queue = getSessionQueue(SESSION_ID);
    expect(queue.length).toBe(1);
    expect(queue[0].retryCount).toBe(1);
    expect(queue[0].nextRetryAt).toBeGreaterThan(Date.now());
  });
});
