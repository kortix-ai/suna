import { afterEach, expect, spyOn, test } from 'bun:test';
import { finalizeServerSignOut } from './finalize-sign-out';

afterEach(() => { globalThis.fetch = originalFetch; });
const originalFetch = globalThis.fetch;

test('sign-out uses a stable same-origin POST rather than a build-specific action', async () => {
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await finalizeServerSignOut();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toBe('/api/auth/sign-out');
  expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
  expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  request.mockRestore();
});

test('a refused endpoint remains a failure for the bounded sign-out sequence', async () => {
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  await expect(finalizeServerSignOut()).rejects.toThrow('Server sign-out failed (503)');
  request.mockRestore();
});
