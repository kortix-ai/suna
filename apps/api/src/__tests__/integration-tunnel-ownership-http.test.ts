import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  accountMembers,
  accounts,
  tunnelConnections,
  tunnelPermissionRequests,
  tunnelPermissions,
} from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../shared/db';
import { executeComputerCall } from '../tunnel/core/rpc-core';
import { createConnectionsRouter } from '../tunnel/routes/connections';
import { createPermissionRequestsRouter } from '../tunnel/routes/permission-requests';
import { createPermissionsRouter } from '../tunnel/routes/permissions';
import { createRpcRouter } from '../tunnel/routes/rpc';

const ORGANIZATION = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const MEMBER = crypto.randomUUID();

let organizationTunnel = '';
let ownerTunnel = '';
let adminTunnel = '';
let memberTunnel = '';

function appFor(userId: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('authType' as never, 'supabase' as never);
    c.set('accountId' as never, ORGANIZATION as never);
    c.set('userId' as never, userId as never);
    await next();
  });
  app.route('/connections', createConnectionsRouter());
  app.route('/rpc', createRpcRouter());
  app.route('/permission-requests', createPermissionRequestsRouter());
  app.route('/permissions', createPermissionsRouter());
  return app;
}

async function listConnectionIds(userId: string): Promise<string[]> {
  const response = await appFor(userId).request('/connections');
  expect(response.status).toBe(200);
  const rows = (await response.json()) as Array<{ tunnelId: string }>;
  return rows.map((row) => row.tunnelId);
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ORGANIZATION, name: 'tunnel-ownership-test' });
  await db.insert(accountMembers).values([
    { accountId: ORGANIZATION, userId: OWNER, accountRole: 'owner' },
    { accountId: ORGANIZATION, userId: ADMIN, accountRole: 'admin' },
    { accountId: ORGANIZATION, userId: MEMBER, accountRole: 'member' },
  ]);
  const rows = await db
    .insert(tunnelConnections)
    .values([
      {
        accountId: ORGANIZATION,
        name: 'Organization computer',
        capabilities: ['filesystem'],
      },
      { accountId: OWNER, name: 'Owner computer', capabilities: ['filesystem'] },
      { accountId: ADMIN, name: 'Admin computer', capabilities: ['filesystem'] },
      {
        accountId: MEMBER,
        name: 'Member computer',
        capabilities: ['filesystem', 'shell'],
      },
    ])
    .returning({ tunnelId: tunnelConnections.tunnelId, name: tunnelConnections.name });
  organizationTunnel = rows.find((row) => row.name === 'Organization computer')!.tunnelId;
  ownerTunnel = rows.find((row) => row.name === 'Owner computer')!.tunnelId;
  adminTunnel = rows.find((row) => row.name === 'Admin computer')!.tunnelId;
  memberTunnel = rows.find((row) => row.name === 'Member computer')!.tunnelId;
});

afterAll(async () => {
  const ids = [organizationTunnel, ownerTunnel, adminTunnel, memberTunnel].filter(Boolean);
  if (ids.length > 0) {
    await db.delete(tunnelConnections).where(inArray(tunnelConnections.tunnelId, ids));
  }
  await db.delete(accountMembers).where(eq(accountMembers.accountId, ORGANIZATION));
  await db.delete(accounts).where(eq(accounts.accountId, ORGANIZATION));
});

describe('raw tunnel organization boundary', () => {
  test('organization owners and admins see the organization fleet plus only their personal fleet', async () => {
    expect(new Set(await listConnectionIds(OWNER))).toEqual(
      new Set([organizationTunnel, ownerTunnel]),
    );
    expect(new Set(await listConnectionIds(ADMIN))).toEqual(
      new Set([organizationTunnel, adminTunnel]),
    );
  });

  test('a regular organization member cannot list or call an organization tunnel', async () => {
    expect(await listConnectionIds(MEMBER)).toEqual([memberTunnel]);

    const response = await appFor(MEMBER).request(`/rpc/${organizationTunnel}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'fs.read', params: { path: '/etc/hosts' } }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Tunnel connection not found' });
  });
});

describe('physical machine owner controls permission approval', () => {
  test('profile discovery and RPC use the live registered capability set', async () => {
    await db
      .update(tunnelConnections)
      .set({
        capabilities: ['filesystem', 'desktop'],
        machineInfo: { registeredCapabilities: ['filesystem'] },
      })
      .where(eq(tunnelConnections.tunnelId, memberTunnel));

    const listed = await executeComputerCall({
      accountId: ORGANIZATION,
      allowedTunnelIds: [memberTunnel],
      allowedTunnelAccountIds: [MEMBER],
      selector: null,
      method: 'list_computers',
      args: {},
    });
    expect(listed).toEqual({
      ok: true,
      data: {
        computers: [
          expect.objectContaining({
            id: memberTunnel,
            capabilities: ['filesystem'],
          }),
        ],
      },
    });

    const desktop = await executeComputerCall({
      accountId: ORGANIZATION,
      allowedTunnelIds: [memberTunnel],
      allowedTunnelAccountIds: [MEMBER],
      selector: memberTunnel,
      method: 'desktop.cua.get_screen_size',
      args: {},
    });
    expect(desktop).toEqual({
      ok: false,
      kind: 'error',
      message:
        'Capability is not registered by the connected Agent Tunnel: desktop. Update and reconnect the local agent.',
    });

    await db
      .update(tunnelConnections)
      .set({ capabilities: ['filesystem', 'shell'], machineInfo: {} })
      .where(eq(tunnelConnections.tunnelId, memberTunnel));
  });

  test('a personal-machine request is stored for and visible only to its owner', async () => {
    const result = await executeComputerCall({
      accountId: ORGANIZATION,
      allowedTunnelIds: [memberTunnel],
      allowedTunnelAccountIds: [MEMBER],
      selector: memberTunnel,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== 'permission_required') return;

    const [stored] = await db
      .select()
      .from(tunnelPermissionRequests)
      .where(eq(tunnelPermissionRequests.requestId, result.requestId));
    expect(stored?.accountId).toBe(MEMBER);

    const adminList = await appFor(ADMIN).request('/permission-requests');
    expect(adminList.status).toBe(200);
    expect(
      ((await adminList.json()) as Array<{ requestId: string }>).map((row) => row.requestId),
    ).not.toContain(result.requestId);

    const ownerList = await appFor(MEMBER).request('/permission-requests');
    expect(ownerList.status).toBe(200);
    expect(
      ((await ownerList.json()) as Array<{ requestId: string }>).map((row) => row.requestId),
    ).toContain(result.requestId);

    const adminApproval = await appFor(ADMIN).request(
      `/permission-requests/${result.requestId}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(adminApproval.status).toBe(404);

    const ownerApproval = await appFor(MEMBER).request(
      `/permission-requests/${result.requestId}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(ownerApproval.status).toBe(200);

    const [permission] = await db
      .select()
      .from(tunnelPermissions)
      .where(
        and(
          eq(tunnelPermissions.tunnelId, memberTunnel),
          eq(tunnelPermissions.capability, 'filesystem'),
        ),
      );
    expect(permission?.accountId).toBe(MEMBER);
  });

  test('approval fails closed when the machine capability was removed', async () => {
    const result = await executeComputerCall({
      accountId: ORGANIZATION,
      allowedTunnelIds: [memberTunnel],
      allowedTunnelAccountIds: [MEMBER],
      selector: memberTunnel,
      method: 'shell.exec',
      args: { command: 'echo secure' },
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== 'permission_required') return;

    await db
      .update(tunnelConnections)
      .set({ capabilities: ['filesystem'], updatedAt: new Date() })
      .where(eq(tunnelConnections.tunnelId, memberTunnel));

    const response = await appFor(MEMBER).request(
      `/permission-requests/${result.requestId}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Capability is not enabled: shell' });

    const rows = await db
      .select()
      .from(tunnelPermissions)
      .where(
        and(
          eq(tunnelPermissions.tunnelId, memberTunnel),
          eq(tunnelPermissions.capability, 'shell'),
          eq(tunnelPermissions.status, 'active'),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  test('direct grants reject capabilities absent from the machine registration', async () => {
    const response = await appFor(MEMBER).request(`/permissions/${memberTunnel}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'desktop' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Capability is not enabled: desktop' });
  });
});
