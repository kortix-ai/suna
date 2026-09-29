/**
 * Real HTTP + Postgres proof for computers as ACCOUNTS (Kortix Local Mode).
 *
 * A paired machine is one `connector_connections` row on the project's
 * `computer` connector, owned by the member who paired it (private) or by the
 * project (shared). This suite drives the real routes and the real gateway:
 *
 *   • device-auth approve creates the machine, its wire permissions, and a
 *     PRIVATE computer account in one step; `share: project` needs the
 *     connections-manage capability;
 *   • another member neither lists nor reaches that account;
 *   • an unattended session (service-account creator, or a shared session)
 *     reaches the project computer and never a member's;
 *   • `POST /projects/:id/computers` is idempotent and ownership-checked;
 *   • the gateway maps machine state to `computer_offline`,
 *     `computer_unpaired`, `computer_capability_not_approved`, and answers
 *     `status` server-side;
 *   • unpairing revokes every account of the machine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  accountMembers,
  accounts,
  auditEvents,
  connectorActions,
  connectorConnections,
  connectors,
  projectMembers,
  projectSessions,
  projects,
  tunnelConnections,
  tunnelDeviceAuthRequests,
  tunnelPermissions,
} from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { syncProjectConnectors } from '../connectors/sync';
import { handleCall } from '../connectors/gateway';
import type { ConnectorPrincipal } from '../connectors/router';
import { app } from '../index';
import { listEntitledConnectorConnections } from '../projects/lib/session-connector-bindings';
import { createAccountToken } from '../repositories/account-tokens';
import { createServiceAccount } from '../repositories/service-accounts';
import { db } from '../shared/db';
import { relayOwnerPatch } from '../tunnel/core/cluster-forwarder';
import { createConnectionsRouter } from '../tunnel/routes/connections';
import { createRpcRouter } from '../tunnel/routes/rpc';
import { deleteFromView, insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const OTHER_ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const UNATTENDED_SESSION = crypto.randomUUID();
const SHARED_SESSION = crypto.randomUUID();
const tokens: Record<string, string> = {};
const minted: string[] = [];
let serviceAccountId = '';

let aliceTunnel = '';
let aliceConnection = '';
let sharedTunnel = '';

beforeAll(async () => {
  await db.execute(sql`alter type kortix.connector_provider add value if not exists 'computer'`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'computer-accounts-http' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'computer-accounts-http',
    repoUrl: 'https://example.invalid/computer-accounts.git',
    metadata: {},
  });
  await insertIntoView(db, accountMembers, [
    { accountId: ACCOUNT, userId: OWNER, accountRole: 'owner' },
    { accountId: ACCOUNT, userId: MANAGER, accountRole: 'member' },
    { accountId: ACCOUNT, userId: ALICE, accountRole: 'member' },
    { accountId: ACCOUNT, userId: BOB, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: ALICE, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: BOB, projectRole: 'member' },
  ]);
  for (const [name, userId] of Object.entries({ OWNER, MANAGER, ALICE, BOB })) {
    // A user-scoped PAT: project-scoped tokens cannot call /v1/tunnel/*.
    const token = await createAccountToken({
      accountId: ACCOUNT,
      userId,
      name: `computer-accounts-${name}`,
      agentGrant: null,
    });
    minted.push(token.tokenId);
    tokens[userId] = token.secretKey;
  }
  const serviceAccount = await createServiceAccount({
    accountId: ACCOUNT,
    name: `computer-accounts-${crypto.randomUUID()}`,
    createdBy: OWNER,
  });
  serviceAccountId = serviceAccount.serviceAccountId;
  await db.insert(projectSessions).values([
    {
      sessionId: UNATTENDED_SESSION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: UNATTENDED_SESSION,
      createdBy: serviceAccountId,
      visibility: 'private',
    },
    {
      sessionId: SHARED_SESSION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SHARED_SESSION,
      createdBy: ALICE,
      visibility: 'project',
    },
  ]);
});

afterAll(async () => {
  await db.execute(
    sql`delete from kortix.account_tokens where token_id in (${sql.join(
      minted.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db
    .delete(tunnelConnections)
    .where(inArray(tunnelConnections.accountId, [ACCOUNT, OTHER_ACCOUNT]));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await deleteFromView(db, accountMembers, eq(accountMembers.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

let ipCounter = 0;
function request(method: string, path: string, token: string | null, body?: unknown) {
  ipCounter += 1;
  return app.request(path, {
    method,
    headers: {
      'x-forwarded-for': `198.51.100.${ipCounter % 250}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function startPairing(body: Record<string, unknown>) {
  const response = await request('POST', '/v1/tunnel/device-auth', null, body);
  expect(response.status).toBe(201);
  return (await response.json()) as { deviceCode: string; deviceSecret: string };
}

function approve(userId: string, code: string, body: Record<string, unknown>) {
  return request('POST', `/v1/tunnel/device-auth/${code}/approve`, tokens[userId]!, body);
}

async function computerConnection(connectionId: string) {
  const [row] = await db
    .select()
    .from(connectorConnections)
    .where(eq(connectorConnections.connectionId, connectionId));
  return row;
}

async function listedConnections(userId: string) {
  const response = await request('GET', `/v1/projects/${PROJECT}/connections`, tokens[userId]!);
  expect(response.status).toBe(200);
  return ((await response.json()) as { connections: Array<Record<string, any>> }).connections;
}

/** The direct tunnel routes, mounted with a fake interactive session. */
function tunnelAppFor(userId: string) {
  const tunnel = new Hono();
  tunnel.use('*', async (c, next) => {
    c.set('authType' as never, 'supabase' as never);
    c.set('accountId' as never, ACCOUNT as never);
    c.set('userId' as never, userId as never);
    await next();
  });
  tunnel.route('/connections', createConnectionsRouter());
  tunnel.route('/rpc', createRpcRouter());
  return tunnel;
}

function principal(overrides: Partial<ConnectorPrincipal> = {}): ConnectorPrincipal {
  const userId = overrides.userId ?? BOB;
  return {
    userId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    sessionId: null,
    subject: { userId, groupIds: [] },
    agentGrant: null,
    ...overrides,
  };
}

function call(p: ConnectorPrincipal, actionPath: string, args: Record<string, unknown> = {}) {
  return handleCall(dbConnectorRouterDeps.makeGatewayDeps(p), {
    projectId: PROJECT,
    accountId: ACCOUNT,
    subject: p.subject,
    sessionId: p.sessionId,
    connectorSlug: 'computer',
    actionPath,
    args,
  });
}

describe('pairing a computer creates a private computer account', () => {
  test('the machine sends project_id; info echoes it; approve creates machine, wire grants, and the account', async () => {
    const pairing = await startPairing({ machineHostname: 'alice-mac.local', project_id: PROJECT });
    const info = await request(
      'GET',
      `/v1/tunnel/device-auth/${pairing.deviceCode}/info`,
      tokens[ALICE]!,
    );
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ projectId: PROJECT, status: 'pending' });

    const approved = await approve(ALICE, pairing.deviceCode, {
      name: 'Alice Mac',
      capabilities: ['filesystem', 'shell'],
    });
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as { tunnelId: string; connectionId: string };
    aliceTunnel = body.tunnelId;
    aliceConnection = body.connectionId;

    const [machine] = await db
      .select()
      .from(tunnelConnections)
      .where(eq(tunnelConnections.tunnelId, aliceTunnel));
    expect(machine).toMatchObject({ accountId: ACCOUNT, ownerUserId: ALICE, name: 'Alice Mac' });
    const grants = await db
      .select({ capability: tunnelPermissions.capability })
      .from(tunnelPermissions)
      .where(eq(tunnelPermissions.tunnelId, aliceTunnel));
    expect(new Set(grants.map((grant) => grant.capability))).toEqual(
      new Set(['filesystem', 'shell']),
    );

    const connection = await computerConnection(aliceConnection);
    expect(connection).toMatchObject({
      projectId: PROJECT,
      ownerType: 'member',
      ownerId: ALICE,
      label: 'Alice Mac',
      status: 'active',
      isDefault: true,
      tunnelId: aliceTunnel,
    });
    const [connector] = await db
      .select({ slug: connectors.slug, providerType: connectors.providerType })
      .from(connectors)
      .where(eq(connectors.connectorId, connection!.connectorId));
    expect(connector).toEqual({ slug: 'computer', providerType: 'computer' });
  });

  test('approve without a project (none sent by the machine) is refused', async () => {
    const pairing = await startPairing({ machineHostname: 'no-project.local' });
    const response = await approve(ALICE, pairing.deviceCode, { capabilities: [] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'project_id is required' });
  });

  test('approve into a project the caller cannot read is 404, and the request stays pending', async () => {
    const pairing = await startPairing({ machineHostname: 'foreign.local' });
    const response = await approve(ALICE, pairing.deviceCode, {
      project_id: crypto.randomUUID(),
      capabilities: [],
    });
    expect(response.status).toBe(404);
    const [row] = await db
      .select({ status: tunnelDeviceAuthRequests.status })
      .from(tunnelDeviceAuthRequests)
      .where(eq(tunnelDeviceAuthRequests.deviceCode, pairing.deviceCode));
    expect(row?.status).toBe('pending');
  });

  test('share=project needs the connections-manage capability', async () => {
    const pairing = await startPairing({ machineHostname: 'bob-mac.local', project_id: PROJECT });
    const refused = await approve(BOB, pairing.deviceCode, { capabilities: [], share: 'project' });
    expect(refused.status).toBe(403);

    const shared = await startPairing({ machineHostname: 'studio.local', project_id: PROJECT });
    const ok = await approve(MANAGER, shared.deviceCode, {
      name: 'Studio',
      capabilities: ['filesystem'],
      share: 'project',
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { tunnelId: string; connectionId: string };
    sharedTunnel = body.tunnelId;
    expect(await computerConnection(body.connectionId)).toMatchObject({
      ownerType: 'project',
      ownerId: null,
      isDefault: true,
      tunnelId: sharedTunnel,
    });
  });
});

describe('a private computer stays private', () => {
  test("the owner lists it with tunnel_id and machine status; another member does not", async () => {
    const alice = await listedConnections(ALICE);
    expect(alice.find((row) => row.connection_id === aliceConnection)).toMatchObject({
      connector_alias: 'computer',
      owner_type: 'member',
      tunnel_id: aliceTunnel,
      machine: { online: false, last_heartbeat_at: null },
    });
    const bob = await listedConnections(BOB);
    expect(bob.map((row) => row.connection_id)).not.toContain(aliceConnection);
    // Bob sees the project computer, with its machine field.
    expect(bob.find((row) => row.tunnel_id === sharedTunnel)).toMatchObject({
      owner_type: 'project',
      machine: { online: false },
    });
  });

  test('the direct machine list shows only the caller-owned machines', async () => {
    const aliceList = await tunnelAppFor(ALICE).request('/connections');
    const aliceIds = ((await aliceList.json()) as Array<{ tunnelId: string }>).map((r) => r.tunnelId);
    expect(aliceIds).toEqual([aliceTunnel]);
    const bobList = await tunnelAppFor(BOB).request('/connections');
    const bobIds = ((await bobList.json()) as Array<{ tunnelId: string }>).map((r) => r.tunnelId);
    expect(bobIds).not.toContain(aliceTunnel);

    const rpc = await tunnelAppFor(BOB).request(`/rpc/${aliceTunnel}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'fs.read', params: { path: '/etc/hosts' } }),
    });
    expect(rpc.status).toBe(404);
  });

  test('another member cannot name it, even with --account', async () => {
    const res = await call(principal({ userId: BOB, requestedConnectorAccount: 'Alice Mac' }), 'status');
    expect(res.status).toBe('denied');
    if (res.status === 'denied') expect(res.reason).toContain('connector_not_connected');
  });

  test('the owner gets account_required with two pinned computers, and reaches hers by name', async () => {
    const ambiguous = await call(principal({ userId: ALICE }), 'status');
    expect(ambiguous.status).toBe('denied');
    if (ambiguous.status === 'denied') expect(ambiguous.reason).toContain('account_required');

    const mine = await call(principal({ userId: ALICE, requestedConnectorAccount: 'me' }), 'status');
    expect(mine).toMatchObject({
      status: 'ok',
      data: { name: 'Alice Mac', online: false, capabilities: ['filesystem', 'shell'] },
      account: { connection_id: aliceConnection, owner_type: 'member' },
    });
  });
});

describe('unattended runs reach only project computers', () => {
  const reach = async (input: Parameters<typeof listEntitledConnectorConnections>[0]) =>
    (await listEntitledConnectorConnections(input)).map((row) => row.connectionId);

  test('a service-account session resolves the shared computer, never a member one', async () => {
    const res = await call(
      principal({ userId: serviceAccountId, sessionId: UNATTENDED_SESSION }),
      'status',
    );
    expect(res).toMatchObject({ status: 'ok', data: { name: 'Studio' }, account: { owner_type: 'project' } });
  });

  test("a shared session of the owner and an agent with no on-behalf-of human never see Alice's computer", async () => {
    const sharedSession = await call(principal({ userId: ALICE, sessionId: SHARED_SESSION }), 'status');
    expect(sharedSession).toMatchObject({ status: 'ok', data: { name: 'Studio' } });

    const agent = await reach({
      accountId: ACCOUNT,
      projectId: PROJECT,
      alias: 'computer',
      actingUserId: ALICE,
      agentPrincipal: { onBehalfOfUserId: null },
      visibility: 'private',
    });
    expect(agent).not.toContain(aliceConnection);
    expect(agent).toHaveLength(1);
  });
});

describe('the gateway maps machine state onto typed errors', () => {
  test('offline → computer_offline without relaying', async () => {
    const res = await call(principal(), 'fs.read', { path: '/etc/hosts' });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.reason).toStartWith('computer_offline: ');
  });

  test('a capability not approved at pairing → computer_capability_not_approved', async () => {
    await db
      .update(tunnelConnections)
      .set({
        status: 'online',
        lastHeartbeatAt: new Date(),
        machineInfo: { registeredCapabilities: ['filesystem', 'desktop'] },
        ...relayOwnerPatch(),
      })
      .where(eq(tunnelConnections.tunnelId, sharedTunnel));
    const res = await call(principal(), 'desktop.cua.list_apps');
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.reason).toStartWith('computer_capability_not_approved: ');
      expect(res.reason).toContain('Re-pair this computer to allow desktop');
    }
  });

  test('a relayed call is audited in the connector namespace; a dead relay maps to computer_offline', async () => {
    const res = await call(principal(), 'fs.read', { path: '/etc/hosts' });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.reason).toStartWith('computer_offline: ');
    const rows = await db
      .select({ source: auditEvents.authoritativeSource })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.projectId, PROJECT),
          eq(auditEvents.resourceId, sharedTunnel),
          eq(auditEvents.action, 'connector.computer.fs.read'),
        ),
      );
    expect(rows.some((row) => row.source === 'connector')).toBe(true);
  });

  test('an active account whose machine link is gone → computer_unpaired', async () => {
    const [row] = await db
      .select({ connectionId: connectorConnections.connectionId })
      .from(connectorConnections)
      .where(eq(connectorConnections.tunnelId, sharedTunnel));
    await db
      .update(connectorConnections)
      .set({ tunnelId: null })
      .where(eq(connectorConnections.connectionId, row!.connectionId));
    const res = await call(principal(), 'status');
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.reason).toStartWith('computer_unpaired: ');
    await db
      .update(connectorConnections)
      .set({ tunnelId: sharedTunnel })
      .where(eq(connectorConnections.connectionId, row!.connectionId));
  });
});

describe('the computer connector is a regular connector', () => {
  test('a require_approval policy gates a computer call like any connector call', async () => {
    const write = await dbConnectorRouterDeps.setConnectorPolicies!(PROJECT, ACCOUNT, 'computer', [
      { match: 'status', action: 'require_approval' },
    ]);
    expect(write.ok).toBe(true);
    const res = await call(principal(), 'status');
    expect(res.status).toBe('pending_approval');
    const clear = await dbConnectorRouterDeps.setConnectorPolicies!(PROJECT, ACCOUNT, 'computer', []);
    expect(clear.ok).toBe(true);
  });

  test('a manifest sync keeps the computer connector, its accounts, and its policies', async () => {
    await dbConnectorRouterDeps.setConnectorPolicies!(PROJECT, ACCOUNT, 'computer', [
      { match: 'fs.delete', action: 'block' },
    ]);
    await syncProjectConnectors(PROJECT, ACCOUNT);
    const [connector] = await db
      .select({ connectorId: connectors.connectorId, config: connectors.config })
      .from(connectors)
      .where(and(eq(connectors.projectId, PROJECT), eq(connectors.slug, 'computer')));
    expect(connector?.config).toEqual({ auth: { type: 'none', in: 'header', name: null, prefix: null } });
    const actions = await db
      .select({ path: connectorActions.path })
      .from(connectorActions)
      .where(eq(connectorActions.connectorId, connector!.connectorId));
    expect(actions.map((action) => action.path)).toContain('status');
    expect(actions.map((action) => action.path)).not.toContain('list_computers');
    const policies = await dbConnectorRouterDeps.getConnectorPolicies!(PROJECT, 'computer');
    expect(policies?.policies).toEqual([{ match: 'fs.delete', action: 'block' }]);
    expect((await computerConnection(aliceConnection))?.status).toBe('active');
    const machineless = await db
      .select()
      .from(connectorConnections)
      .where(and(eq(connectorConnections.connectorId, connector!.connectorId), isNull(connectorConnections.tunnelId)));
    expect(machineless).toEqual([]);
  });

  test('creating a computer connector through the connector API only names it', async () => {
    const created = await dbConnectorRouterDeps.createConnector!(PROJECT, ACCOUNT, {
      slug: 'computer',
      name: 'Team computers',
      provider: 'computer',
    });
    expect(created.ok).toBe(true);
    const rows = await db
      .select({ name: connectors.name })
      .from(connectors)
      .where(and(eq(connectors.projectId, PROJECT), eq(connectors.providerType, 'computer')));
    expect(rows).toEqual([{ name: 'Team computers' }]);
  });
});

describe('POST /projects/:id/computers adds an already-paired computer', () => {
  let laptop = '';
  let teamMachine = '';
  let foreignMachine = '';

  beforeAll(async () => {
    const rows = await db
      .insert(tunnelConnections)
      .values([
        { accountId: ACCOUNT, ownerUserId: ALICE, name: 'Alice Laptop', capabilities: ['filesystem'] },
        { accountId: ACCOUNT, ownerUserId: null, name: 'Team Server', capabilities: ['shell'] },
        { accountId: OTHER_ACCOUNT, ownerUserId: ALICE, name: 'Alice Elsewhere', capabilities: [] },
      ])
      .returning({ tunnelId: tunnelConnections.tunnelId, name: tunnelConnections.name });
    laptop = rows.find((row) => row.name === 'Alice Laptop')!.tunnelId;
    teamMachine = rows.find((row) => row.name === 'Team Server')!.tunnelId;
    foreignMachine = rows.find((row) => row.name === 'Alice Elsewhere')!.tunnelId;
  });

  const add = (userId: string, body: Record<string, unknown>) =>
    request('POST', `/v1/projects/${PROJECT}/computers`, tokens[userId]!, body);

  test('the owner adds it privately; a repeat returns the same account', async () => {
    const first = await add(ALICE, { tunnel_id: laptop });
    expect(first.status).toBe(201);
    const created = (await first.json()) as Record<string, any>;
    expect(created).toMatchObject({
      connector_alias: 'computer',
      owner_type: 'member',
      owner_id: ALICE,
      label: 'Alice Laptop',
      is_default: false,
      tunnel_id: laptop,
      machine: { online: false },
    });
    const again = await add(ALICE, { tunnel_id: laptop, share: 'me' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Record<string, any>).connection_id).toBe(created.connection_id);
    const rows = await db
      .select()
      .from(connectorConnections)
      .where(and(eq(connectorConnections.tunnelId, laptop), eq(connectorConnections.ownerId, ALICE)));
    expect(rows).toHaveLength(1);
  });

  test("another member cannot add the owner's machine", async () => {
    expect((await add(BOB, { tunnel_id: laptop })).status).toBe(404);
  });

  test('sharing with the project needs the manage capability', async () => {
    expect((await add(ALICE, { tunnel_id: laptop, share: 'project' })).status).toBe(403);
  });

  test("a machine in another account is 409", async () => {
    const response = await add(ALICE, { tunnel_id: foreignMachine });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'COMPUTER_ACCOUNT_MISMATCH' });
  });

  test('an owner-less team machine: only an account manager may share it, never privately', async () => {
    expect((await add(MANAGER, { tunnel_id: teamMachine, share: 'project' })).status).toBe(404);
    expect((await add(OWNER, { tunnel_id: teamMachine })).status).toBe(404);
    const shared = await add(OWNER, { tunnel_id: teamMachine, share: 'project' });
    expect(shared.status).toBe(201);
    expect(await shared.json()).toMatchObject({ owner_type: 'project', tunnel_id: teamMachine });
  });

  test('the generic connection routes refuse to create a computer account', async () => {
    const response = await request('POST', `/v1/projects/${PROJECT}/connections/me`, tokens[ALICE]!, {
      connector_alias: 'computer',
      label: 'Hand-made',
    });
    expect(response.status).toBe(409);
  });
});

describe('unpairing revokes the computer accounts', () => {
  test('DELETE /tunnel/connections/:id revokes, unpins, and unlinks every account of the machine', async () => {
    const response = await tunnelAppFor(ALICE).request(`/connections/${aliceTunnel}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(await computerConnection(aliceConnection)).toMatchObject({
      status: 'revoked',
      isDefault: false,
      tunnelId: null,
    });
    const mine = await call(principal({ userId: ALICE, requestedConnectorAccount: 'Alice Mac' }), 'status');
    expect(mine.status).toBe('denied');
  });

  test('another member cannot unpair a machine they do not own', async () => {
    const response = await tunnelAppFor(BOB).request(`/connections/${sharedTunnel}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });
});
