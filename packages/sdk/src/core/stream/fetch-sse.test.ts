import { afterEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../http/api/errors';
import { buildTunnelEventStreamUrl, createTunnelEventStream } from './fetch-sse';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// The API deleted `GET /v1/tunnel/permission-requests/stream` with tunnel
// permission requests (#8168). Both exports fail at once instead of opening a
// stream that can only 404.
test.each([
  ['buildTunnelEventStreamUrl', () => buildTunnelEventStreamUrl('https://api.example.test/v1/')],
  ['createTunnelEventStream', () => createTunnelEventStream('https://api.example.test/v1/', { token: 't' })],
] as const)('%s is retired and sends no request', (name, call) => {
  const fetchMock = mock(async () => new Response(''));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  let error: unknown;
  try {
    call();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe('ENDPOINT_RETIRED');
  expect((error as ApiError).message).toBe(`${name}() is retired: the Kortix API no longer serves this endpoint.`);
  expect(fetchMock).not.toHaveBeenCalled();
});
