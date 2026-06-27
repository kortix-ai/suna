import { describe, expect, test } from 'bun:test';
import { TunnelRelay } from './relay';

function fakeWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
  } as unknown as WebSocket;
}

describe('TunnelRelay connection lifecycle', () => {
  test('stale close from a replaced socket does not unregister the active agent', () => {
    const relay = new TunnelRelay();
    const first = fakeWs();
    const second = fakeWs();

    relay.registerAgent('tnl_1', first, 'signing-key-1', { accountId: 'acct_1' });
    relay.registerAgent('tnl_1', second, 'signing-key-2', { accountId: 'acct_1' });

    const removed = relay.unregisterAgent('tnl_1', first);

    expect(removed).toBe(false);
    expect(relay.isConnected('tnl_1')).toBe(true);
    expect(relay.getConnectedCount()).toBe(1);
  });

  test('close from the active socket unregisters the agent and emits metadata', () => {
    const relay = new TunnelRelay();
    const ws = fakeWs();
    const events: unknown[] = [];
    relay.on('agent:disconnect', (event) => events.push(event));

    relay.registerAgent('tnl_1', ws, 'signing-key', { accountId: 'acct_1' });
    const removed = relay.unregisterAgent('tnl_1', ws);

    expect(removed).toBe(true);
    expect(relay.isConnected('tnl_1')).toBe(false);
    expect(events).toEqual([{ tunnelId: 'tnl_1', metadata: { accountId: 'acct_1' } }]);
  });
});
