import { describe, expect, test } from 'bun:test';
import { FetchTransport, KeepAliveTransport, ResponseError } from './rpc-transport.ts';

/**
 * The real transports, against a real local server: a response-received
 * failure must be a `ResponseError` (the request was delivered — never
 * retried), while a connection failure must not be one (retryable).
 */
describe('transport failure classes', () => {
  test('fetch: a non-2xx response is a ResponseError, a connection failure is not', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('no', { status: 502 }) });
    try {
      const transport = new FetchTransport(`http://127.0.0.1:${server.port}`, {});
      const boom = await transport.call('writeFile', {}, '/').then(
        () => null,
        (e: unknown) => e,
      );
      expect(boom).toBeInstanceOf(ResponseError);
      if (boom instanceof ResponseError) expect(boom.message).toBe('HTTP 502');

      const refused = await new FetchTransport('http://127.0.0.1:1', {})
        .call('writeFile', {}, '/')
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(refused).toBeInstanceOf(Error);
      expect(refused).not.toBeInstanceOf(ResponseError);
    } finally {
      server.stop(true);
    }
  });

  test('keepalive: a malformed JSON body is a ResponseError, a connection failure is not', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('<html>502</html>', { status: 502 }),
    });
    try {
      const transport = new KeepAliveTransport(`http://127.0.0.1:${server.port}`, {});
      const boom = await transport.call('writeFile', {}, '/').then(
        () => null,
        (e: unknown) => e,
      );
      expect(boom).toBeInstanceOf(ResponseError);
      if (boom instanceof ResponseError) expect(boom.message).toBe('malformed JSON body');

      const refused = await new KeepAliveTransport('http://127.0.0.1:1', {})
        .call('writeFile', {}, '/')
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(refused).toBeInstanceOf(Error);
      expect(refused).not.toBeInstanceOf(ResponseError);
    } finally {
      server.stop(true);
    }
  });
});
