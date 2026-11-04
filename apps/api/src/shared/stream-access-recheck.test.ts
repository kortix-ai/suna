import { afterEach, expect, jest, test } from 'bun:test';
import { endStreamOnRevoke, recheckStreamAccess, STREAM_ACCESS_RECHECK_MS } from './stream-access-recheck';

afterEach(() => jest.useRealTimers());

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

test('L5: a stream whose caller left the private channel ends on the next re-check, within 60 s', async () => {
  jest.useFakeTimers();
  let allowed = true;
  let revoked = 0;
  recheckStreamAccess(async () => allowed, () => {
    revoked += 1;
  });
  jest.advanceTimersByTime(STREAM_ACCESS_RECHECK_MS);
  await flush();
  expect(revoked).toBe(0);
  allowed = false; // removed from the channel
  jest.advanceTimersByTime(STREAM_ACCESS_RECHECK_MS);
  await flush();
  expect(revoked).toBe(1);
  jest.advanceTimersByTime(STREAM_ACCESS_RECHECK_MS * 3);
  await flush();
  expect(revoked).toBe(1);
});

test('a failed access read keeps the stream open', async () => {
  jest.useFakeTimers();
  let revoked = 0;
  recheckStreamAccess(
    async () => {
      throw new Error('db down');
    },
    () => {
      revoked += 1;
    },
  );
  jest.advanceTimersByTime(STREAM_ACCESS_RECHECK_MS * 2);
  await flush();
  expect(revoked).toBe(0);
});

test('a stopped stream never re-checks', async () => {
  jest.useFakeTimers();
  let checks = 0;
  const stop = recheckStreamAccess(async () => {
    checks += 1;
    return false;
  }, () => {});
  stop();
  jest.advanceTimersByTime(STREAM_ACCESS_RECHECK_MS * 2);
  await flush();
  expect(checks).toBe(0);
});

test('I4: a proxied runtime event stream ends on the first re-check after its caller lost access', async () => {
  const encoder = new TextEncoder();
  let push: ((chunk: string) => void) | null = null;
  let cancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  let allowed = true;
  const reader = endStreamOnRevoke(upstream, async () => allowed, 5).getReader();
  push!('data: one\n\n');
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n');
  allowed = false; // removed from the private channel
  const next = await reader.read();
  expect(next.done).toBe(true);
  expect(cancelled).toBe(true);
});
