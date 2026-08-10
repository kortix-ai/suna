import { describe, expect, test } from 'bun:test';
import { signMessage } from '../shared/crypto';
import { TunnelRelay } from './relay';
import { createWsHandlers } from './ws-handler';

interface FakeSocket extends WebSocket {
  sent: string[];
  closes: Array<{ code?: number; reason?: string }>;
}

function fakeWs(): FakeSocket {
  const socket = {
    readyState: WebSocket.OPEN,
    sent: [] as string[],
    closes: [] as Array<{ code?: number; reason?: string }>,
    send(data: string) {
      this.sent.push(data);
    },
    close(code?: number, reason?: string) {
      this.closes.push({ code, reason });
    },
  };
  return socket as unknown as FakeSocket;
}

function throwingWs(): FakeSocket {
  const socket = fakeWs();
  socket.send = () => {
    throw new Error('socket closed');
  };
  return socket;
}

describe('tunnel WebSocket identity binding', () => {
  test('passes the exact live capability registration into authentication', async () => {
    const relay = new TunnelRelay();
    let receivedAuth: unknown;
    const handlers = createWsHandlers(relay, {
      onAuthenticate: async (_tunnelId, _token, auth) => {
        receivedAuth = auth;
        return { signingKey: 'session-key', metadata: { capabilities: auth.capabilities } };
      },
    });
    const socket = fakeWs();
    handlers.onOpen('tunnel-1', socket);
    await handlers.onMessage(
      'tunnel-1',
      socket,
      JSON.stringify({
        type: 'auth',
        token: 'legitimate-token',
        capabilities: ['filesystem', 'desktop'],
        agentVersion: '0.1.2',
      }),
    );

    expect(receivedAuth).toEqual({
      type: 'auth',
      token: 'legitimate-token',
      capabilities: ['filesystem', 'desktop'],
      agentVersion: '0.1.2',
    });
    expect(relay.getAgentMetadata('tunnel-1')?.capabilities).toEqual([
      'filesystem',
      'desktop',
    ]);
  });

  test('authenticates the socket that supplied the credential during a same-tunnel race', async () => {
    const relay = new TunnelRelay();
    const handlers = createWsHandlers(relay, {
      onAuthenticate: async (_tunnelId, token) =>
        token === 'legitimate-token' ? { signingKey: 'session-key' } : null,
    });
    const legitimate = fakeWs();
    const racing = fakeWs();

    handlers.onOpen('tunnel-1', legitimate);
    handlers.onOpen('tunnel-1', racing);
    await handlers.onMessage(
      'tunnel-1',
      legitimate,
      JSON.stringify({ type: 'auth', token: 'legitimate-token' }),
    );

    expect(legitimate.sent).toHaveLength(1);
    expect(JSON.parse(legitimate.sent[0]!)).toEqual({
      type: 'auth_ok',
      signingKey: 'session-key',
    });
    expect(racing.sent).toEqual([]);
    expect(relay.isConnected('tunnel-1')).toBe(true);

    await handlers.onMessage(
      'tunnel-1',
      racing,
      JSON.stringify({ type: 'auth', token: 'wrong-token' }),
    );
    expect(racing.closes).toContainEqual({ code: 4001, reason: 'authentication failed' });
    expect(relay.isConnected('tunnel-1')).toBe(true);
  });

  test('discards signed messages from a socket after that socket was replaced', () => {
    const relay = new TunnelRelay();
    const first = fakeWs();
    const second = fakeWs();
    const pongs: unknown[] = [];
    relay.on('message:pong', (event) => pongs.push(event));
    relay.registerAgent('tunnel-1', first, 'old-key');
    relay.registerAgent('tunnel-1', second, 'new-key');

    const payload = {
      jsonrpc: '2.0' as const,
      method: 'tunnel.pong',
      params: { source: 'old-socket' },
    };
    const raw = JSON.stringify({
      ...payload,
      _sig: signMessage('old-key', JSON.stringify(payload), 1),
      _nonce: 1,
    });
    relay.handleAgentMessage('tunnel-1', first, raw);

    expect(pongs).toEqual([]);
  });

  test('does not register a socket that cannot receive the session key', async () => {
    const relay = new TunnelRelay();
    const handlers = createWsHandlers(relay, {
      onAuthenticate: async () => ({ signingKey: 'session-key' }),
    });
    const socket = throwingWs();
    handlers.onOpen('tunnel-1', socket);

    await handlers.onMessage(
      'tunnel-1',
      socket,
      JSON.stringify({ type: 'auth', token: 'legitimate-token' }),
    );

    expect(relay.isConnected('tunnel-1')).toBe(false);
    expect(socket.closes).toContainEqual({
      code: 4001,
      reason: 'authentication response failed',
    });
  });

  test('closes an authenticated socket after an oversized message', () => {
    const relay = new TunnelRelay();
    const handlers = createWsHandlers(relay, { maxMessageSize: 8 });
    const socket = fakeWs();
    relay.registerAgent('tunnel-1', socket, 'session-key');

    handlers.onMessage('tunnel-1', socket, '123456789');

    expect(socket.closes).toContainEqual({ code: 4002, reason: 'message too large' });
  });
});
