import { afterEach, describe, expect, test } from 'bun:test';
import { tunnelConnections, tunnelRpcForwards } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';

import { fingerprintTunnelCredentialHash, hashSecretKey } from '../shared/crypto';
import { db } from '../shared/db';
import { API_INSTANCE_ID } from '../shared/instance';
import {
  relayRpcToConnectedAgent,
  startTunnelRpcForwarder,
  stopTunnelRpcForwarder,
} from '../tunnel/core/cluster-forwarder';
import { tunnelRelay } from '../tunnel/core/relay';

const tunnels = new Set<string>();
const forwards = new Set<string>();

function fakeSocket() {
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    readyState: WebSocket.OPEN,
    send() {},
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
    closed,
  };
}

async function createConnectedTunnel() {
  const tunnelId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const oldHash = hashSecretKey(`kortix_tnl_${crypto.randomUUID()}`);
  await db.insert(tunnelConnections).values({
    tunnelId,
    accountId,
    name: `cluster-credential-${tunnelId}`,
    capabilities: ['filesystem'],
    setupTokenHash: oldHash,
    status: 'online',
    relayOwnerId: API_INSTANCE_ID,
    relayOwnerHeartbeatAt: new Date(),
  });
  tunnels.add(tunnelId);
  const socket = fakeSocket();
  tunnelRelay.registerAgent(tunnelId, socket as unknown as WebSocket, 'session-key', {
    accountId,
    credentialFingerprint: fingerprintTunnelCredentialHash(oldHash),
  });
  return { tunnelId, accountId, socket };
}

async function waitForForward(requestId: string, status: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select()
      .from(tunnelRpcForwards)
      .where(eq(tunnelRpcForwards.requestId, requestId));
    if (row?.status === status) return row;
    await Bun.sleep(20);
  }
  throw new Error(`Forward ${requestId} did not reach ${status}`);
}

afterEach(async () => {
  stopTunnelRpcForwarder();
  for (const tunnelId of tunnels) tunnelRelay.disconnectAgent(tunnelId);
  if (forwards.size > 0) {
    await db
      .delete(tunnelRpcForwards)
      .where(inArray(tunnelRpcForwards.requestId, [...forwards]));
  }
  if (tunnels.size > 0) {
    await db
      .delete(tunnelConnections)
      .where(inArray(tunnelConnections.tunnelId, [...tunnels]));
  }
  forwards.clear();
  tunnels.clear();
});

describe('live relay credential invalidation', () => {
  test('token rotation on another replica blocks the next local RPC and closes the socket', async () => {
    const { tunnelId, accountId, socket } = await createConnectedTunnel();
    await db
      .update(tunnelConnections)
      .set({ setupTokenHash: hashSecretKey(`kortix_tnl_${crypto.randomUUID()}`) })
      .where(eq(tunnelConnections.tunnelId, tunnelId));

    await expect(
      relayRpcToConnectedAgent({
        tunnelId,
        accountId,
        method: 'fs.read',
        params: { path: '/etc/hosts' },
      }),
    ).rejects.toThrow('credential was rotated');
    expect(tunnelRelay.isConnected(tunnelId)).toBe(false);
    expect(socket.closed).toContainEqual({ code: 4003, reason: 'device credential rotated' });
  });

  test('token rotation blocks the next forwarded RPC on the relay-owner replica', async () => {
    const { tunnelId, accountId, socket } = await createConnectedTunnel();
    await db
      .update(tunnelConnections)
      .set({ setupTokenHash: hashSecretKey(`kortix_tnl_${crypto.randomUUID()}`) })
      .where(eq(tunnelConnections.tunnelId, tunnelId));
    const [forward] = await db
      .insert(tunnelRpcForwards)
      .values({
        tunnelId,
        accountId,
        requesterRelayOwnerId: 'other-replica:1',
        targetRelayOwnerId: API_INSTANCE_ID,
        method: 'fs.read',
        params: { path: '/etc/hosts' },
        expiresAt: new Date(Date.now() + 5_000),
      })
      .returning({ requestId: tunnelRpcForwards.requestId });
    forwards.add(forward.requestId);

    startTunnelRpcForwarder();
    const row = await waitForForward(forward.requestId, 'error');
    expect(row.error).toMatchObject({ message: expect.stringContaining('credential') });
    expect(tunnelRelay.isConnected(tunnelId)).toBe(false);
    expect(socket.closed).toContainEqual({ code: 4003, reason: 'device credential revoked' });
  });

  test('a deleted connection cannot retain a usable local relay socket', async () => {
    const { tunnelId, accountId, socket } = await createConnectedTunnel();
    await db.delete(tunnelConnections).where(eq(tunnelConnections.tunnelId, tunnelId));

    await expect(
      relayRpcToConnectedAgent({
        tunnelId,
        accountId,
        method: 'fs.read',
        params: { path: '/etc/hosts' },
      }),
    ).rejects.toThrow('credential is no longer valid');
    expect(tunnelRelay.isConnected(tunnelId)).toBe(false);
    expect(socket.closed).toContainEqual({ code: 4003, reason: 'device credential revoked' });
  });
});
