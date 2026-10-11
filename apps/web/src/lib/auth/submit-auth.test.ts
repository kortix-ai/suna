// The auth page submits its forms through POST route handlers with a hard
// deadline: a hung submission must surface an error the visitor can retry
// instead of a disabled button that never comes back. These tests pin the
// helper's contract — bounded fetch, failure reasons, JSON passthrough.
import { afterEach, expect, test } from 'bun:test';
import { AUTH_TIMEOUT_MESSAGE, submitAuthForm } from './submit-auth';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const formData = () => {
  const data = new FormData();
  data.set('email', 'synthetic@example.test');
  return data;
};

test('a submission that never answers fails within the deadline as a timeout', async () => {
  // Browser contract: fetch rejects when its signal aborts (the repo's own
  // download-route test stubs it the same way).
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as typeof fetch;
  const outcome = await submitAuthForm('/api/auth/send-code', formData(), 30);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe('timeout');
    expect(outcome.message).toBe(AUTH_TIMEOUT_MESSAGE);
  }
});

test('an error response passes the server message through as a server failure', async () => {
  globalThis.fetch = (async () =>
    Response.json({ message: 'Signups are closed' }, { status: 400 })) as unknown as typeof fetch;
  const outcome = await submitAuthForm('/api/auth/send-code', formData());
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe('server');
    expect(outcome.message).toBe('Signups are closed');
  }
});

test('a success response passes the action result through', async () => {
  globalThis.fetch = (async () =>
    Response.json({ success: true, email: 'synthetic@example.test' })) as unknown as typeof fetch;
  const outcome = await submitAuthForm('/api/auth/send-code', formData());
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.result.success).toBe(true);
});

test('a network failure maps to the network reason, not a thrown error', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const outcome = await submitAuthForm('/api/auth/send-code', formData());
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe('network');
    expect(outcome.message.length).toBeGreaterThan(0);
  }
});
