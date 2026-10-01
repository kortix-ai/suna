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
 *   • unpairing revokes every account of the machine;
 *   • v2: approve needs no project, every project the owner opens gets their
 *     machines as private accounts (never resurrecting a revoked one), labels
 *     follow renames, the agent's access mode is stored and shown, access
 *     refusals map to typed errors, the legacy `computer` argument selects an
 *     account, and a machine can unpair itself with its own token.
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
  sessionSandboxes,
  tunnelConnections,
  tunnelDeviceAuthRequests,
  tunnelPermissions,
} from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { ensureDefaultConnection } from '../connectors/credentials';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { ensureProjectComputer, syncProjectConnectors } from '../connectors/sync';
import { runWithContext } from '../lib/request-context';
import { setImpersonationContext } from '../shared/impersonation';
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
import { generateTunnelToken, hashSecretKey } from '../shared/crypto';
import { parseAccessState } from '../tunnel';
import { computerAccessErrorKind, machineAccess } from '../tunnel/core/rpc-core';

const ACCOUNT = crypto.randomUUID();
const OTHER_ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PROJECT_TWO = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const CAROL = crypto.randomUUID();
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
    { accountId: ACCOUNT, userId: CAROL, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: ALICE, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: BOB, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: CAROL, projectRole: 'manager' },
  ]);
  for (const [name, userId] of Object.entries({ OWNER, MANAGER, ALICE, BOB, CAROL })) {
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
  // A session token is valid only while its sandbox is live.
  await db.insert(sessionSandboxes).values({
    sandboxId: SHARED_SESSION,
    sessionId: SHARED_SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    externalId: `computer-accounts-${SHARED_SESSION}`,
    status: 'active',
  });
});

afterAll(async () => {
  await db.execute(
    sql`delete from kortix.account_tokens where token_id in (${sql.join(
      minted.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  // The sandbox identity guard allows the delete once the session is deleted.
  await db.execute(sql`
    update kortix.project_sessions
       set metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb
     where project_id = ${PROJECT}::uuid`);
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.projectId, PROJECT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db
    .delete(connectorConnections)
    .where(inArray(connectorConnections.projectId, [PROJECT, PROJECT_TWO]));
  await db.delete(connectors).where(inArray(connectors.projectId, [PROJECT, PROJECT_TWO]));
  await db
    .delete(tunnelConnections)
    // Private machines live in their owner's personal account (id = user id).
    .where(inArray(tunnelConnections.accountId, [ACCOUNT, OTHER_ACCOUNT, OWNER, MANAGER, ALICE, BOB, CAROL]));
  await deleteFromView(db, projectMembers, eq(projectMembers.projectId, PROJECT_TWO));
  await db.delete(projects).where(inArray(projects.projectId, [PROJECT, PROJECT_TWO]));
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
    // A private machine lives in its owner's personal account, where the
    // previous API image never shows it to the team's owners and admins.
    expect(machine).toMatchObject({ accountId: ALICE, ownerUserId: ALICE, name: 'Alice Mac' });
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

  test('approve without a project pairs the machine to the caller alone; sharing still needs one', async () => {
    const pairing = await startPairing({ machineHostname: 'no-project.local' });
    const response = await approve(ALICE, pairing.deviceCode, { name: 'Alice Travel', capabilities: [] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tunnelId: string; connectionId: string | null };
    expect(body.connectionId).toBeNull();
    const [machine] = await db
      .select()
      .from(tunnelConnections)
      .where(eq(tunnelConnections.tunnelId, body.tunnelId));
    expect(machine).toMatchObject({ accountId: ALICE, ownerUserId: ALICE, name: 'Alice Travel' });
    const accounts = await db
      .select({ connectionId: connectorConnections.connectionId })
      .from(connectorConnections)
      .where(eq(connectorConnections.tunnelId, body.tunnelId));
    expect(accounts).toEqual([]);

    const unshared = await startPairing({ machineHostname: 'no-project-shared.local' });
    const refused = await approve(MANAGER, unshared.deviceCode, { capabilities: [], share: 'project' });
    expect(refused.status).toBe(400);
  });

  test('an agent session token cannot approve a pairing', async () => {
    const sessionToken = await createAccountToken({
      accountId: ACCOUNT,
      userId: ALICE,
      name: 'computer-accounts-approve-session',
      projectId: PROJECT,
      sessionId: SHARED_SESSION,
      agentGrant: { agent: 'main', connectors: [], permissions: 'all' },
    });
    minted.push(sessionToken.tokenId);
    const pairing = await startPairing({ machineHostname: 'agent.local' });
    const response = await request(
      'POST',
      `/v1/tunnel/device-auth/${pairing.deviceCode}/approve`,
      sessionToken.secretKey,
      { capabilities: [] },
    );
    expect(response.status).toBe(403);
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
    const [machine] = await db.select().from(tunnelConnections).where(eq(tunnelConnections.tunnelId, sharedTunnel));
    expect(machine?.accountId).toBe(ACCOUNT);
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
    const aliceRows = (await aliceList.json()) as Array<{ tunnelId: string; ownerUserId: string }>;
    expect(aliceRows.map((r) => r.tunnelId)).toContain(aliceTunnel);
    expect(aliceRows.every((r) => r.ownerUserId === ALICE)).toBe(true);
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

  test('the legacy `computer` argument naming nothing the caller may use is refused, never relayed', async () => {
    const res = await call(principal(), 'fs.read', { computer: 'Some Other Machine', path: '/etc/hosts' });
    expect(res.status).toBe('denied');
    if (res.status === 'denied') {
      expect(res.reason).toStartWith('account_not_found: ');
      expect(res.reason).toContain('--account');
    }
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
    // The legacy keys make the previous API image read a new connector as an
    // explicit profile with no machines (deny, never fold, never delete).
    expect(connector?.config).toEqual({
      auth: { type: 'none', in: 'header', name: null, prefix: null },
      computer_profile: true,
      tunnel_ids: [],
      computer_accounts_backfilled: true,
    });
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
  let managerForeignMachine = '';

  beforeAll(async () => {
    const rows = await db
      .insert(tunnelConnections)
      .values([
        { accountId: ACCOUNT, ownerUserId: ALICE, name: 'Alice Laptop', capabilities: ['filesystem'] },
        { accountId: ACCOUNT, ownerUserId: null, name: 'Team Server', capabilities: ['shell'] },
        { accountId: OTHER_ACCOUNT, ownerUserId: ALICE, name: 'Alice Elsewhere', capabilities: [] },
        { accountId: OTHER_ACCOUNT, ownerUserId: MANAGER, name: 'Manager Elsewhere', capabilities: [] },
      ])
      .returning({ tunnelId: tunnelConnections.tunnelId, name: tunnelConnections.name });
    laptop = rows.find((row) => row.name === 'Alice Laptop')!.tunnelId;
    teamMachine = rows.find((row) => row.name === 'Team Server')!.tunnelId;
    foreignMachine = rows.find((row) => row.name === 'Alice Elsewhere')!.tunnelId;
    managerForeignMachine = rows.find((row) => row.name === 'Manager Elsewhere')!.tunnelId;
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

  test("the owner's machine from another account joins privately; sharing it is 409", async () => {
    const privately = await add(ALICE, { tunnel_id: foreignMachine });
    expect(privately.status).toBe(201);
    expect(await privately.json()).toMatchObject({ owner_type: 'member', owner_id: ALICE, tunnel_id: foreignMachine });
    const shared = await add(MANAGER, { tunnel_id: managerForeignMachine, share: 'project' });
    expect(shared.status).toBe(409);
    expect(await shared.json()).toMatchObject({ code: 'COMPUTER_ACCOUNT_MISMATCH' });
  });

  test('an agent session token cannot add or share its creator\'s computer', async () => {
    const sessionToken = await createAccountToken({
      accountId: ACCOUNT,
      userId: ALICE,
      name: 'computer-accounts-session',
      projectId: PROJECT,
      sessionId: SHARED_SESSION,
      agentGrant: { agent: 'main', connectors: [], permissions: 'all' },
    });
    minted.push(sessionToken.tokenId);
    for (const share of ['me', 'project']) {
      const response = await request('POST', `/v1/projects/${PROJECT}/computers`, sessionToken.secretKey, {
        tunnel_id: laptop,
        share,
      });
      expect(response.status).toBe(403);
    }
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
    if (mine.status === 'denied') expect(mine.reason).toContain('computer_unpaired');
  });

  test('another member cannot unpair a machine they do not own', async () => {
    const response = await tunnelAppFor(BOB).request(`/connections/${sharedTunnel}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });
});

describe('v2: the computer follows its owner into every project', () => {
  let travel = '';

  beforeAll(async () => {
    await db.insert(projects).values({
      projectId: PROJECT_TWO,
      accountId: ACCOUNT,
      name: 'computer-accounts-http-two',
      repoUrl: 'https://example.invalid/computer-accounts-two.git',
      metadata: {},
    });
    await insertIntoView(db, projectMembers, [
      { accountId: ACCOUNT, projectId: PROJECT_TWO, userId: ALICE, projectRole: 'member' },
      { accountId: ACCOUNT, projectId: PROJECT_TWO, userId: BOB, projectRole: 'member' },
    ]);
    const [row] = await db
      .select({ tunnelId: tunnelConnections.tunnelId })
      .from(tunnelConnections)
      .where(and(eq(tunnelConnections.ownerUserId, ALICE), eq(tunnelConnections.name, 'Alice Travel')));
    travel = row!.tunnelId;
  });

  const listIn = async (userId: string) => {
    const response = await request('GET', `/v1/projects/${PROJECT_TWO}/connections`, tokens[userId]!);
    expect(response.status).toBe(200);
    return ((await response.json()) as { connections: Array<Record<string, any>> }).connections;
  };

  test("listing a second project creates the owner's private accounts once, one default", async () => {
    const first = await listIn(ALICE);
    const mine = first.filter((row) => row.connector_alias === 'computer');
    expect(mine.every((row) => row.owner_type === 'member' && row.owner_id === ALICE)).toBe(true);
    expect(new Set(mine.map((row) => row.label))).toEqual(
      new Set(['Alice Laptop', 'Alice Elsewhere', 'Alice Travel']),
    );
    expect(mine.filter((row) => row.is_default)).toHaveLength(1);
    const again = await listIn(ALICE);
    expect(again.filter((row) => row.connector_alias === 'computer')).toHaveLength(mine.length);
    // Bob owns no machine: the built-in connector exists, with no account of his.
    expect((await listIn(BOB)).filter((row) => row.connector_alias === 'computer')).toEqual([]);
    const listed = await request('GET', `/v1/connectors/projects/${PROJECT_TWO}/connectors`, tokens[OWNER]!);
    expect(listed.status).toBe(200);
    const connectorList = ((await listed.json()) as { connectors: Array<Record<string, any>> }).connectors;
    expect(connectorList.map((row) => row.slug)).toContain('computer');
  });

  test('an account the owner revoked in this project is not recreated', async () => {
    const [account] = await db
      .select()
      .from(connectorConnections)
      .where(and(eq(connectorConnections.projectId, PROJECT_TWO), eq(connectorConnections.tunnelId, travel)));
    await db
      .update(connectorConnections)
      .set({ status: 'revoked', isDefault: false })
      .where(eq(connectorConnections.connectionId, account!.connectionId));
    await listIn(ALICE);
    const rows = await db
      .select({ status: connectorConnections.status })
      .from(connectorConnections)
      .where(and(eq(connectorConnections.projectId, PROJECT_TWO), eq(connectorConnections.tunnelId, travel)));
    expect(rows).toEqual([{ status: 'revoked' }]);
  });

  test("renaming the machine relabels its accounts in every project", async () => {
    const renamed = await tunnelAppFor(ALICE).request(`/connections/${travel}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice Road Mac' }),
    });
    expect(renamed.status).toBe(200);
    const labels = await db
      .select({ label: connectorConnections.label })
      .from(connectorConnections)
      .where(eq(connectorConnections.tunnelId, travel));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((row) => row.label === 'Alice Road Mac')).toBe(true);
  });

  test('a session on behalf of the owner resolves the computer and gets its accounts', async () => {
    const res = await call(principal({ userId: ALICE, requestedConnectorAccount: 'Alice Laptop' }), 'status');
    expect(res).toMatchObject({ status: 'ok', data: { name: 'Alice Laptop' } });
  });
});

describe('v2: access mode on the machine', () => {
  test('tunnel.access.state params are validated', () => {
    expect(parseAccessState({ mode: 'ask', grantedUntil: '2026-09-29T14:32:00Z' })).toEqual({
      mode: 'ask',
      grantedUntil: '2026-09-29T14:32:00.000Z',
    });
    expect(parseAccessState({ mode: 'always', grantedUntil: null })).toEqual({ mode: 'always', grantedUntil: null });
    expect(parseAccessState({ mode: 'sometimes' })).toBeNull();
    expect(parseAccessState({ mode: 'ask', grantedUntil: 'soon' })).toBeNull();
    expect(parseAccessState(null)).toBeNull();
  });

  test('the stored access shows on the connection view and in `status`', async () => {
    const grantedUntil = new Date(Date.now() + 60_000).toISOString();
    const [laptop] = await db
      .select({ tunnelId: tunnelConnections.tunnelId })
      .from(tunnelConnections)
      .where(and(eq(tunnelConnections.ownerUserId, ALICE), eq(tunnelConnections.name, 'Alice Laptop')));
    await db
      .update(tunnelConnections)
      .set({ machineInfo: { access: { mode: 'ask', grantedUntil } } })
      .where(eq(tunnelConnections.tunnelId, laptop!.tunnelId));
    const listed = await listedConnections(ALICE);
    expect(listed.find((row) => row.tunnel_id === laptop!.tunnelId)?.machine).toMatchObject({
      access: { mode: 'ask', granted_until: grantedUntil },
    });
    const status = await call(principal({ userId: ALICE, requestedConnectorAccount: 'Alice Laptop' }), 'status');
    expect(status).toMatchObject({
      status: 'ok',
      data: { access: { mode: 'ask', granted_until: grantedUntil } },
    });
  });

  test('agent access refusals map by code, then by message prefix', () => {
    expect(computerAccessErrorKind(-32010, 'x')).toBe('computer_access_pending');
    expect(computerAccessErrorKind(-32011, 'x')).toBe('computer_access_denied');
    expect(computerAccessErrorKind(-32012, 'x')).toBe('computer_access_off');
    expect(computerAccessErrorKind(-32603, 'computer_access_off: turned off')).toBe('computer_access_off');
    expect(computerAccessErrorKind(-32603, 'boom')).toBeNull();
  });
});

describe('v2: the legacy `computer` argument selects an account', () => {
  test('by label and by machine id for the owner; never for another member', async () => {
    const [laptop] = await db
      .select({ tunnelId: tunnelConnections.tunnelId })
      .from(tunnelConnections)
      .where(and(eq(tunnelConnections.ownerUserId, ALICE), eq(tunnelConnections.name, 'Alice Laptop')));
    const byLabel = await call(principal({ userId: ALICE }), 'status', { computer: 'Alice Laptop' });
    expect(byLabel).toMatchObject({ status: 'ok', data: { name: 'Alice Laptop' } });
    const byId = await call(principal({ userId: ALICE }), 'status', { computer: laptop!.tunnelId });
    expect(byId).toMatchObject({ status: 'ok', data: { name: 'Alice Laptop' } });
    const conflicting = await call(
      principal({ userId: ALICE, requestedConnectorAccount: 'Alice Elsewhere' }),
      'status',
      { computer: 'Alice Laptop' },
    );
    expect(conflicting.status).toBe('denied');
    const bob = await call(principal({ userId: BOB }), 'status', { computer: 'Alice Laptop' });
    expect(bob.status).toBe('denied');
    if (bob.status === 'denied') expect(bob.reason).toStartWith('account_not_found: ');
  });
});

describe('v2: DELETE /v1/tunnel/self — a machine unpairs itself', () => {
  test('only its own token works; it deletes the machine and revokes its accounts', async () => {
    const token = generateTunnelToken();
    const [machine] = await db
      .insert(tunnelConnections)
      .values({
        accountId: ACCOUNT,
        ownerUserId: ALICE,
        name: 'Alice Throwaway',
        capabilities: [],
        setupTokenHash: hashSecretKey(token),
      })
      .returning({ tunnelId: tunnelConnections.tunnelId });
    const tunnelId = machine!.tunnelId;
    await listedConnections(ALICE);
    const [account] = await db
      .select({ connectionId: connectorConnections.connectionId })
      .from(connectorConnections)
      .where(eq(connectorConnections.tunnelId, tunnelId));
    expect(account).toBeDefined();

    const unpair = (headers: Record<string, string>) =>
      app.request('/v1/tunnel/self', {
        method: 'DELETE',
        headers: { 'x-forwarded-for': `203.0.113.${(ipCounter += 1) % 250}`, ...headers },
      });
    expect((await unpair({ 'x-tunnel-id': tunnelId, authorization: `Bearer ${generateTunnelToken()}` })).status).toBe(401);
    expect((await unpair({ 'x-tunnel-id': tunnelId, authorization: `Bearer ${tokens[ALICE]}` })).status).toBe(401);
    const ok = await unpair({ 'x-tunnel-id': tunnelId, authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true });
    expect(await db.select().from(tunnelConnections).where(eq(tunnelConnections.tunnelId, tunnelId))).toEqual([]);
    expect(await computerConnection(account!.connectionId)).toMatchObject({ status: 'revoked', tunnelId: null });
    expect((await unpair({ 'x-tunnel-id': tunnelId, authorization: `Bearer ${token}` })).status).toBe(401);
  });
});

describe('a computer account is always one paired machine', () => {
  test('the project-default slot every credential write targets is never created on the computer connector', async () => {
    const [computer] = await db
      .select({ connectorId: connectors.connectorId })
      .from(connectors)
      .where(and(eq(connectors.projectId, PROJECT_TWO), eq(connectors.slug, 'computer')));
    const machineless = () =>
      db
        .select({ connectionId: connectorConnections.connectionId })
        .from(connectorConnections)
        .where(and(eq(connectorConnections.connectorId, computer!.connectorId), isNull(connectorConnections.tunnelId)));
    const before = await machineless();
    await expect(ensureDefaultConnection({ projectId: PROJECT_TWO, connectorId: computer!.connectorId })).rejects.toThrow(
      /pair/i,
    );
    expect(await machineless()).toEqual(before);
  });
});

describe('contract v2 review fixes', () => {
  test('approving "Only you" ignores a project the machine named that the approver cannot read', async () => {
    const pairing = await startPairing({ machineHostname: 'stale-project.local', project_id: crypto.randomUUID() });
    const response = await approve(ALICE, pairing.deviceCode, { capabilities: [] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tunnelId: string; connectionId: string | null };
    expect(body.connectionId).toBeNull();
    const [machine] = await db.select().from(tunnelConnections).where(eq(tunnelConnections.tunnelId, body.tunnelId));
    expect(machine).toMatchObject({ accountId: ALICE, ownerUserId: ALICE });
  });

  test("a machine shared with the project gives its owner no second, private account", async () => {
    await listedConnections(MANAGER);
    const rows = await db
      .select({ ownerType: connectorConnections.ownerType })
      .from(connectorConnections)
      .where(and(eq(connectorConnections.projectId, PROJECT), eq(connectorConnections.tunnelId, sharedTunnel)));
    expect(rows).toEqual([{ ownerType: 'project' }]);
  });

  test('an impersonating operator never writes computer accounts into the project', async () => {
    const before = await db
      .select({ connectionId: connectorConnections.connectionId })
      .from(connectorConnections)
      .where(and(eq(connectorConnections.projectId, PROJECT_TWO), eq(connectorConnections.ownerId, MANAGER)));
    await runWithContext('GET', `/v1/projects/${PROJECT_TWO}/connections`, () => {
      expect(
        setImpersonationContext({ grantId: crypto.randomUUID(), targetAccountId: ACCOUNT, impersonatorUserId: MANAGER }),
      ).toBe(true);
      return ensureProjectComputer(PROJECT_TWO, MANAGER);
    });
    const after = await db
      .select({ connectionId: connectorConnections.connectionId })
      .from(connectorConnections)
      .where(and(eq(connectorConnections.projectId, PROJECT_TWO), eq(connectorConnections.ownerId, MANAGER)));
    expect(after).toEqual(before);
    // Without impersonation the same call does attach the manager's machine.
    await ensureProjectComputer(PROJECT_TWO, MANAGER);
    const own = await db
      .select({ tunnelId: connectorConnections.tunnelId })
      .from(connectorConnections)
      .where(and(eq(connectorConnections.projectId, PROJECT_TWO), eq(connectorConnections.ownerId, MANAGER)));
    expect(own.map((row) => row.tunnelId)).toContain(sharedTunnel);
  });

  test('the generic share route keeps a computer in its workspace and needs the manage right', async () => {
    const account = async (label: string) => {
      const [row] = await db
        .select({ connectionId: connectorConnections.connectionId })
        .from(connectorConnections)
        .where(
          and(
            eq(connectorConnections.projectId, PROJECT),
            eq(connectorConnections.ownerId, ALICE),
            eq(connectorConnections.label, label),
          ),
        );
      return row!.connectionId;
    };
    const share = (connectionId: string) =>
      request('POST', `/v1/projects/${PROJECT}/connections/${connectionId}/share`, tokens[ALICE]!, {
        principals: [],
      });
    // A team machine of another workspace never becomes this project's account.
    const elsewhere = await account('Alice Elsewhere');
    const refused = await share(elsewhere);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'COMPUTER_ACCOUNT_MISMATCH' });
    // Her machine in this workspace: sharing is the manager right, as for any account.
    const laptop = await account('Alice Laptop');
    expect((await share(laptop)).status).toBe(403);
    for (const id of [elsewhere, laptop]) {
      expect((await computerConnection(id))?.ownerType).toBe('member');
    }
  });

  test('the built-in computer connector cannot be deleted', async () => {
    const result = await dbConnectorRouterDeps.deleteConnector!(PROJECT, 'computer');
    expect(result).toMatchObject({ ok: false, status: 409 });
    const rows = await db
      .select({ connectorId: connectors.connectorId })
      .from(connectors)
      .where(and(eq(connectors.projectId, PROJECT), eq(connectors.slug, 'computer')));
    expect(rows).toHaveLength(1);
  });

  test("a sync keeps the previous API's computer config keys", async () => {
    const legacy = { tunnel_ids: [sharedTunnel], tunnel_account_ids: [ACCOUNT], computer_profile: true };
    await db
      .update(connectors)
      .set({ config: sql`${connectors.config} || ${JSON.stringify(legacy)}::jsonb` })
      .where(and(eq(connectors.projectId, PROJECT), eq(connectors.slug, 'computer')));
    await syncProjectConnectors(PROJECT, ACCOUNT);
    const [row] = await db
      .select({ config: connectors.config })
      .from(connectors)
      .where(and(eq(connectors.projectId, PROJECT), eq(connectors.slug, 'computer')));
    expect(row?.config).toMatchObject({ ...legacy, computer_accounts_backfilled: true });
  });

  test('the owner may share a private (personal-account) machine with a project they manage', async () => {
    const [machine] = await db
      .insert(tunnelConnections)
      .values({ accountId: MANAGER, ownerUserId: MANAGER, name: 'Manager Laptop', capabilities: [] })
      .returning({ tunnelId: tunnelConnections.tunnelId });
    const response = await request('POST', `/v1/projects/${PROJECT}/computers`, tokens[MANAGER]!, {
      tunnel_id: machine!.tunnelId,
      share: 'project',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ owner_type: 'project', tunnel_id: machine!.tunnelId });
  });

  test('a lapsed grant is shown as no grant', () => {
    expect(machineAccess({ access: { mode: 'ask', grantedUntil: '2020-01-01T00:00:00.000Z' } })).toEqual({
      mode: 'ask',
      granted_until: null,
    });
  });
});

describe('one machine, one registration', () => {
  const HARDWARE = 'a'.repeat(64);
  let carolTunnel = '';
  let carolConnection = '';

  async function pairCarol(body: Record<string, unknown>, approval: Record<string, unknown> = {}) {
    const pairing = await startPairing({ machineHostname: 'carol-mac.local', ...body });
    const response = await approve(CAROL, pairing.deviceCode, {
      name: 'Carol Mac',
      capabilities: ['filesystem', 'shell'],
      project_id: PROJECT,
      ...approval,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { tunnelId: string; connectionId: string };
  }
  const carolMachines = () =>
    db
      .select({ tunnelId: tunnelConnections.tunnelId })
      .from(tunnelConnections)
      .where(eq(tunnelConnections.ownerUserId, CAROL));

  test('re-pairing the same hardware reuses the machine and its account, with a new credential and grants', async () => {
    const first = await pairCarol({ machine_id: HARDWARE });
    carolTunnel = first.tunnelId;
    carolConnection = first.connectionId;
    const [before] = await db
      .select()
      .from(tunnelConnections)
      .where(eq(tunnelConnections.tunnelId, carolTunnel));
    expect(before!.machineInfo).toMatchObject({ machineId: HARDWARE });

    const again = await pairCarol({ machine_id: HARDWARE }, { name: 'Carol MacBook', capabilities: ['filesystem'] });
    expect(again).toMatchObject({ tunnelId: carolTunnel, connectionId: carolConnection });
    const [after] = await db
      .select()
      .from(tunnelConnections)
      .where(eq(tunnelConnections.tunnelId, carolTunnel));
    expect(after!.name).toBe('Carol MacBook');
    expect(after!.setupTokenHash).not.toBe(before!.setupTokenHash);
    const grants = await db
      .select({ capability: tunnelPermissions.capability })
      .from(tunnelPermissions)
      .where(eq(tunnelPermissions.tunnelId, carolTunnel));
    expect(new Set(grants.map((grant) => grant.capability))).toEqual(new Set(['filesystem']));
    expect(await carolMachines()).toHaveLength(1);
    const rows = (await listedConnections(CAROL)).filter((row) => row.tunnel_id === carolTunnel);
    expect(rows.map((row) => row.connection_id)).toEqual([carolConnection]);
  });

  test('a machine registered by a heartbeat (an agent paired before machine ids) is reused too', async () => {
    const legacy = await pairCarol({}, { name: 'Carol Legacy' });
    // What the relay merges from a new agent's tunnel.pong.
    await db
      .update(tunnelConnections)
      .set({ machineInfo: sql`${tunnelConnections.machineInfo} || ${JSON.stringify({ machineId: 'b'.repeat(64) })}::jsonb` })
      .where(eq(tunnelConnections.tunnelId, legacy.tunnelId));
    const again = await pairCarol({ machine_id: 'b'.repeat(64) });
    expect(again.tunnelId).toBe(legacy.tunnelId);
  });

  test('other hardware, no id, or a malformed id pairs a new machine', async () => {
    const before = (await carolMachines()).length;
    const other = await pairCarol({ machine_id: 'c'.repeat(64) });
    const none = await pairCarol({});
    const malformed = await pairCarol({ machine_id: 'not-a-hash' });
    expect(new Set([other.tunnelId, none.tunnelId, malformed.tunnelId, carolTunnel]).size).toBe(4);
    expect(await carolMachines()).toHaveLength(before + 3);
  });

  test("another person's pairing of the same hardware never takes over the owner's machine", async () => {
    const pairing = await startPairing({ machineHostname: 'carol-mac.local', machine_id: HARDWARE });
    const response = await approve(BOB, pairing.deviceCode, { name: 'Bob on Carol Mac', capabilities: ['shell'] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tunnelId: string };
    expect(body.tunnelId).not.toBe(carolTunnel);
    const [carol] = await db
      .select({ ownerUserId: tunnelConnections.ownerUserId, name: tunnelConnections.name })
      .from(tunnelConnections)
      .where(eq(tunnelConnections.tunnelId, carolTunnel));
    expect(carol).toEqual({ ownerUserId: CAROL, name: 'Carol MacBook' });
  });

  test('the approval page names the machine the approver already registered, and only theirs', async () => {
    const info = async (userId: string, code: string) => {
      const response = await request('GET', `/v1/tunnel/device-auth/${code}/info`, tokens[userId]!);
      expect(response.status).toBe(200);
      return ((await response.json()) as { registered: unknown }).registered;
    };
    const known = await startPairing({ machineHostname: 'carol-mac.local', machine_id: HARDWARE });
    expect(await info(CAROL, known.deviceCode)).toEqual({
      tunnelId: carolTunnel,
      name: 'Carol MacBook',
      capabilities: ['filesystem'],
      isLive: false,
    });
    // Alice never paired this hardware; an agent without an id matches nothing.
    expect(await info(ALICE, known.deviceCode)).toBeNull();
    const anonymous = await startPairing({ machineHostname: 'carol-mac.local' });
    expect(await info(CAROL, anonymous.deviceCode)).toBeNull();
  });

  test('Share works like any account: the owner picks who, and the computer stays one account', async () => {
    const response = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections/${carolConnection}/share`,
      tokens[CAROL]!,
      { principals: [{ principal_type: 'user', principal_id: CAROL }, { principal_type: 'user', principal_id: ALICE }] },
    );
    expect(response.status).toBe(200);
    expect(await computerConnection(carolConnection)).toMatchObject({
      ownerType: 'project',
      ownerId: null,
      tunnelId: carolTunnel,
      status: 'active',
    });
    // Listing (which ensures every owner's private accounts) and re-pairing
    // both keep the one shared account; no second private row appears.
    const listed = (await listedConnections(CAROL)).filter((row) => row.tunnel_id === carolTunnel);
    expect(listed.map((row) => row.connection_id)).toEqual([carolConnection]);
    expect(listed[0]!.shared_with.map((share: { principal_id: string }) => share.principal_id).sort()).toEqual(
      [ALICE, CAROL].sort(),
    );
    const again = await pairCarol({ machine_id: HARDWARE });
    expect(again).toMatchObject({ tunnelId: carolTunnel, connectionId: carolConnection });
    const rows = await db
      .select({ connectionId: connectorConnections.connectionId })
      .from(connectorConnections)
      .where(eq(connectorConnections.tunnelId, carolTunnel));
    expect(rows).toHaveLength(1);
  });

  test('disconnecting the shared computer in one project returns it to its owner alone', async () => {
    const revoked = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connections/${carolConnection}/revoke`,
      tokens[CAROL]!,
      {},
    );
    expect(revoked.status).toBe(200);
    const active = (await listedConnections(CAROL)).filter(
      (row) => row.tunnel_id === carolTunnel && row.status === 'active',
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ owner_type: 'member' });
    expect(active[0]!.connection_id).not.toBe(carolConnection);
  });

  test('only the owner, as a human, may share a computer', async () => {
    const mine = await pairCarol({ machine_id: 'd'.repeat(64) });
    const sessionToken = await createAccountToken({
      accountId: ACCOUNT,
      userId: CAROL,
      name: 'computer-share-session',
      projectId: PROJECT,
      sessionId: SHARED_SESSION,
      agentGrant: { agent: 'main', connectors: [], permissions: 'all' },
    });
    minted.push(sessionToken.tokenId);
    const bySession = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections/${mine.connectionId}/share`,
      sessionToken.secretKey,
      { principals: [] },
    );
    expect(bySession.status).toBe(403);
    // Another member does not even see the owner's private account.
    const byOther = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections/${mine.connectionId}/share`,
      tokens[MANAGER]!,
      { principals: [] },
    );
    expect(byOther.status).toBe(404);
    expect(await computerConnection(mine.connectionId)).toMatchObject({ ownerType: 'member', ownerId: CAROL });
  });
});
