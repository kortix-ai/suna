import { afterEach, expect, test } from 'bun:test';
import { createServer, type RequestListener, type Server } from 'node:http';
import { FetchTransport, KeepAliveTransport, type RpcTransport } from './rpc-transport.ts';

const servers: Server[] = [];
const transports: RpcTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

test('fetch cancellation remains active while the response body is incomplete', async () => {
  let cancelled = 0;
  let release!: () => void;
  const url = await listen((request, response) => {
    if (request.url === '/cancel') {
      cancelled += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, value: { cancelled: true } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ok":true,"value":');
    release = () => response.end('"complete"}');
  });
  const transport = new FetchTransport(url);
  transports.push(transport);
  const controller = new AbortController();
  const operation = transport.call(
    'readTextFile',
    { path: '/workspace/file' },
    '/workspace',
    controller.signal,
  );
  const outcome = operation.then(
    () => 'completed',
    () => 'aborted',
  );
  while (!release) await Bun.sleep(1);
  await Bun.sleep(20);
  controller.abort();
  const observed = await Promise.race([outcome, Bun.sleep(300).then(() => 'hung')]);
  release();
  await outcome;
  expect(observed).toBe('aborted');
  expect(cancelled).toBe(1);
});

test('pooled HTTP rejects a failing status even when its body resembles a successful RPC', async () => {
  const url = await listen((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, value: 'proxy fallback' }));
  });
  const transport = new KeepAliveTransport(url);
  transports.push(transport);
  await expect(
    transport.call('writeFile', { path: '/workspace/file', content: 'once' }, '/workspace'),
  ).rejects.toThrow('HTTP 503');
});
