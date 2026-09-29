import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  accountMembers,
  accounts,
  projectMembers,
  projects,
  tunnelConnections,
  tunnelDeviceAuthRequests,
} from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { hashSecretKey } from '../shared/crypto';
import { db } from '../shared/db';
import { createDeviceAuthPublicRouter } from '../tunnel/routes/device-auth';
import { deleteFromView, insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const createdDeviceCodes: string[] = [];
const createdTunnelIds: string[] = [];
let token = '';
let tokenId = '';

function publicApp() {
  const publicRoutes = new Hono();
  publicRoutes.route('/device-auth', createDeviceAuthPublicRouter());
  return publicRoutes;
}

/** The real authenticated approve route, called with the member's PAT. */
function approve(code: string, body: Record<string, unknown>) {
  return app.request(`/v1/tunnel/device-auth/${code}/approve`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ project_id: PROJECT, ...body }),
  });
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

beforeAll(async () => {
  await db.execute(sql`alter type kortix.connector_provider add value if not exists 'computer'`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'device-auth-http' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'device-auth-http',
    repoUrl: 'https://example.invalid/device-auth.git',
    metadata: {},
  });
  await insertIntoView(db, accountMembers, {
    accountId: ACCOUNT,
    userId: USER,
    accountRole: 'member',
  });
  await insertIntoView(db, projectMembers, {
    accountId: ACCOUNT,
    projectId: PROJECT,
    userId: USER,
    projectRole: 'member',
  });
  // A user-scoped PAT: project-scoped tokens cannot call /v1/tunnel/*.
  const minted = await createAccountToken({
    accountId: ACCOUNT,
    userId: USER,
    name: 'device-auth-http',
    agentGrant: null,
  });
  token = minted.secretKey;
  tokenId = minted.tokenId;
});

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
  if (tokenId) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await deleteFromView(db, accountMembers, eq(accountMembers.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('tunnel device authorization handoff', () => {
  test('polling returns the exact approved capabilities without storing a plaintext token', async () => {
    const request = await createRequest();
    const approvedCapabilities = ['desktop', 'filesystem'];
    const approval = await approve(request.deviceCode, {
      name: 'Security Test Mac',
      capabilities: approvedCapabilities,
    });
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
      accountId: ACCOUNT,
      ownerUserId: USER,
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
      accountId: ACCOUNT,
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
    const approveOnce = () => approve(request.deviceCode, { name: 'Concurrent approval', capabilities: [] });

    const responses = await Promise.all([approveOnce(), approveOnce()]);
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
