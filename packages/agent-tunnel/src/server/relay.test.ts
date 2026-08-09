import { describe, expect, test } from 'bun:test';
import { TunnelRelay } from './relay';

function fakeWs(closes: Array<{ code?: number; reason?: string }> = []): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
  } as unknown as WebSocket;
}

describe('TunnelRelay connection lifecycle', () => {
  test('updates live metadata without exposing session signing state', () => {
    const relay = new TunnelRelay();
    relay.registerAgent('tnl_1', fakeWs(), 'signing-key', {
      accountId: 'acct_1',
      capabilities: ['filesystem'],
    });

    expect(relay.updateAgentMetadata('tnl_1', { capabilities: ['desktop'] })).toBe(true);
    expect(relay.getAgentMetadata('tnl_1')).toEqual({
      accountId: 'acct_1',
      capabilities: ['desktop'],
    });
  });

  test('stale close from a replaced socket does not unregister the active agent', () => {
    const relay = new TunnelRelay();
    const closes: Array<{ code?: number; reason?: string }> = [];
    const first = fakeWs(closes);
    const second = fakeWs();

    relay.registerAgent('tnl_1', first, 'signing-key-1', {
      accountId: 'acct_1',
    });
    relay.registerAgent('tnl_1', second, 'signing-key-2', {
      accountId: 'acct_1',
    });

    const removed = relay.unregisterAgent('tnl_1', first);

    expect(removed).toBe(false);
    expect(relay.isConnected('tnl_1')).toBe(true);
    expect(relay.getConnectedCount()).toBe(1);
    expect(closes).toEqual([{ code: 4004, reason: 'replaced by another agent process' }]);
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

  test('rejects an outgoing RPC larger than the configured byte limit', async () => {
    const relay = new TunnelRelay({ maxWsMessageSize: 128 });
    relay.registerAgent('tnl_1', fakeWs(), 'signing-key', {
      accountId: 'acct_1',
    });

    await expect(relay.relayRPC('tnl_1', 'fs.write', { content: 'é'.repeat(128) })).rejects.toThrow(
      'exceeds the maximum tunnel message size',
    );
  });
});
