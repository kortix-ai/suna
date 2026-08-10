import { afterAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { tunnelConnections, tunnelDeviceAuthRequests } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';

import { hashSecretKey } from '../shared/crypto';
import { db } from '../shared/db';
import {
  createDeviceAuthPublicRouter,
  createDeviceAuthRouter,
} from '../tunnel/routes/device-auth';

const USER = crypto.randomUUID();
const createdDeviceCodes: string[] = [];
const createdTunnelIds: string[] = [];

function publicApp() {
  const app = new Hono();
  app.route('/device-auth', createDeviceAuthPublicRouter());
  return app;
}

function authenticatedApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('authType' as never, 'supabase' as never);
    c.set('accountId' as never, USER as never);
    c.set('userId' as never, USER as never);
    await next();
  });
  app.route('/device-auth', createDeviceAuthRouter());
  return app;
}

async function createRequest() {
  const response = await publicApp().request('/device-auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': crypto.randomUUID() },
    body: JSON.stringify({ machineHostname: 'security-test.local' }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    deviceCode: string;
    deviceSecret: string;
  };
  createdDeviceCodes.push(body.deviceCode);
  return body;
}

afterAll(async () => {
  if (createdDeviceCodes.length > 0) {
    await db
      .delete(tunnelDeviceAuthRequests)
      .where(inArray(tunnelDeviceAuthRequests.deviceCode, createdDeviceCodes));
  }
  if (createdTunnelIds.length > 0) {
    await db
      .delete(tunnelConnections)
      .where(inArray(tunnelConnections.tunnelId, createdTunnelIds));
  }
});

describe('tunnel device authorization handoff', () => {
  test('polling returns the exact approved capabilities without storing a plaintext token', async () => {
    const request = await createRequest();
    const approvedCapabilities = ['desktop', 'filesystem'];
    const approval = await authenticatedApp().request(
      `/device-auth/${request.deviceCode}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': crypto.randomUUID() },
        body: JSON.stringify({ name: 'Security Test Mac', capabilities: approvedCapabilities }),
      },
    );
    expect(approval.status).toBe(200);
    const approvalBody = (await approval.json()) as { tunnelId: string };
    createdTunnelIds.push(approvalBody.tunnelId);

    const [handoff] = await db
      .select()
      .from(tunnelDeviceAuthRequests)
      .where(eq(tunnelDeviceAuthRequests.deviceCode, request.deviceCode));
    expect(handoff?.status).toBe('approved');
    expect(handoff?.setupToken).toBeNull();

    const poll = await publicApp().request(`/device-auth/${request.deviceCode}/status`, {
      headers: {
        authorization: `Bearer ${request.deviceSecret}`,
        'x-real-ip': crypto.randomUUID(),
      },
    });
    expect(poll.status).toBe(200);
    const pollBody = (await poll.json()) as {
      status: string;
      tunnelId?: string;
      token?: string;
      capabilities?: string[];
    };
    expect(pollBody.status).toBe('approved');
    expect(pollBody.tunnelId).toBe(approvalBody.tunnelId);
    expect(pollBody.token).toStartWith('kortix_tnl_');
    expect(pollBody.capabilities).toEqual(approvedCapabilities);
  });

  test('an expired approved handoff returns no token', async () => {
    const tunnelId = crypto.randomUUID();
    createdTunnelIds.push(tunnelId);
    await db.insert(tunnelConnections).values({
      tunnelId,
      accountId: USER,
      name: 'Expired handoff',
      capabilities: ['filesystem'],
    });
    const deviceCode = `X${crypto.randomUUID().slice(0, 3).toUpperCase()}-0001`;
    const deviceSecret = crypto.randomUUID();
    createdDeviceCodes.push(deviceCode);
    await db.insert(tunnelDeviceAuthRequests).values({
      deviceCode,
      deviceSecretHash: hashSecretKey(deviceSecret),
      status: 'approved',
      accountId: USER,
      tunnelId,
      setupToken: null,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const response = await publicApp().request(`/device-auth/${deviceCode}/status`, {
      headers: { authorization: `Bearer ${deviceSecret}`, 'x-real-ip': crypto.randomUUID() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'expired' });
  });

  test('concurrent approval creates exactly one tunnel connection', async () => {
    const request = await createRequest();
    const approve = () =>
      authenticatedApp().request(`/device-auth/${request.deviceCode}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': crypto.randomUUID() },
        body: JSON.stringify({ name: 'Concurrent approval', capabilities: [] }),
      });

    const responses = await Promise.all([approve(), approve()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const [handoff] = await db
      .select({ tunnelId: tunnelDeviceAuthRequests.tunnelId })
      .from(tunnelDeviceAuthRequests)
      .where(eq(tunnelDeviceAuthRequests.deviceCode, request.deviceCode));
    expect(handoff?.tunnelId).toBeTruthy();
    createdTunnelIds.push(handoff!.tunnelId!);

    const rows = await db
      .select({ tunnelId: tunnelConnections.tunnelId })
      .from(tunnelConnections)
      .where(eq(tunnelConnections.name, 'Concurrent approval'));
    expect(rows).toEqual([{ tunnelId: handoff!.tunnelId! }]);
  });
});
