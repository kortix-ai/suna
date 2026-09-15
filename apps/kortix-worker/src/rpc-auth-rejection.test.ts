import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { KortixExecutionEnv, type TransportKind } from './kortix-env.ts';

const servers: Server[] = [];
const webSocketServers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    webSocketServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

async function unauthorizedEndpoint(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'user context expired' }));
  });
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function expiredContextWebSocketEndpoint(): Promise<string> {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  servers.push(server);
  webSocketServers.push(webSocketServer);
  webSocketServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { id: number };
      socket.send(
        JSON.stringify({ id: frame.id, body: { error: 'unauthorized', reason: 'expired' } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function unauthorizedCancellationWebSocketEndpoint(): Promise<{
  url: string;
  callStarted: Promise<void>;
  calls: () => number;
}> {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  servers.push(server);
  webSocketServers.push(webSocketServer);
  let calls = 0;
  let markCallStarted!: () => void;
  const callStarted = new Promise<void>((resolve) => {
    markCallStarted = resolve;
  });
  webSocketServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { id: number; type?: string };
      if (frame.type === 'call') {
        calls += 1;
        markCallStarted();
        return;
      }
      socket.send(
        JSON.stringify({ id: frame.id, body: { error: 'unauthorized', reason: 'expired' } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    callStarted,
    calls: () => calls,
  };
}

describe('environment RPC authentication rejection', () => {
  test.each<TransportKind>(['fetch', 'keepalive'])(
    '%s preserves a 401 as a pre-execution rejection',
    async (transport) => {
      const env = new KortixExecutionEnv({
        baseUrl: await unauthorizedEndpoint(),
        cwd: '/workspace',
        transport,
      });

      const result = await env.exec('touch /workspace/result');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('rpc_unauthorized');
        expect(result.error.message).toContain('401');
      }
      await env.cleanup();
    },
  );

  test('ws preserves an expired-context rejection from an established socket', async () => {
    const env = new KortixExecutionEnv({
      baseUrl: await expiredContextWebSocketEndpoint(),
      cwd: '/workspace',
      transport: 'ws',
    });

    const result = await env.exec('touch /workspace/result');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rpc_unauthorized');
      expect(result.error.message).toContain('expired');
    }
    await env.cleanup();
  });

  test('ws does not classify an unauthorized cancellation reply as safe to replay', async () => {
    const endpoint = await unauthorizedCancellationWebSocketEndpoint();
    const env = new KortixExecutionEnv({
      baseUrl: endpoint.url,
      cwd: '/workspace',
      transport: 'ws',
    });
    const controller = new AbortController();
    const operation = env.exec('touch /workspace/result', { abortSignal: controller.signal });
    await endpoint.callStarted;

    controller.abort();
    const result = await operation;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).not.toBe('rpc_unauthorized');
    expect(endpoint.calls()).toBe(1);
    await env.cleanup();
  });
});
