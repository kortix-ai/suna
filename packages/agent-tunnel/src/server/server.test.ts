import { afterEach, describe, expect, test } from 'bun:test';

import { startTunnelServer, type TunnelServer } from './server';

let server: TunnelServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

describe('standalone tunnel WebSocket boundary', () => {
  test('rejects browser-origin WebSocket upgrades before authentication', async () => {
    server = startTunnelServer({ port: 0 });
    const websocketKey = Buffer.from('fixed-test-nonce').toString('base64');
    const response = await fetch(
      `http://127.0.0.1:${server.port}/ws?tunnelId=00000000-0000-4000-8000-000000000001`,
      {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          origin: 'https://attacker.example',
          'sec-websocket-key': websocketKey,
          'sec-websocket-version': '13',
        },
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Browser tunnel WebSockets are not allowed' });
    expect(server.relay.getConnectedCount()).toBe(0);
  });
});

describe('standalone tunnel HTTP routes', () => {
  // Pentest: with no onAuthorizeHTTP the routes listed agents and relayed RPC to anyone.
  test('fail closed when no HTTP authorizer is configured', async () => {
    server = startTunnelServer({ port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/connections`)).status).toBe(403);
    expect((await fetch(`${base}/rpc/00000000-0000-4000-8000-000000000001`, { method: 'POST', body: '{}' })).status).toBe(403);
  });

  test('serve a caller the authorizer accepts', async () => {
    server = startTunnelServer({ port: 0, onAuthorizeHTTP: async (req) => req.headers.get('authorization') === 'Bearer ok' });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/connections`, { headers: { authorization: 'Bearer ok' } })).status).toBe(200);
    expect((await fetch(`${base}/connections`)).status).toBe(403);
  });
});
