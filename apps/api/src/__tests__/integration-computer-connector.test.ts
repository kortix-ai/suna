/**
 * Real-DB integration coverage for grouped Computers connector profiles.
 *
 * This suite proves explicit profile creation, one-to-many tunnel assignment,
 * profile-scoped discovery and routing, independent policies, account-boundary
 * enforcement, and the connector audit namespace.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  auditEvents,
  connectorActions,
  connectorConnections,
  connectorPolicies,
  connectors,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
  tunnelConnections,
  tunnelPermissions,
} from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { synthesizeComputerConnectors } from '../connectors/computer-materialize';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { db } from '../shared/db';
import { executeComputerCall } from '../tunnel/core/rpc-core';

let projectId = '';
let accountId = '';
let otherAccountId = '';
let studioTunnelId = '';
let travelTunnelId = '';
let unassignedTunnelId = '';
let crossAccountTunnelId = '';
const LEGACY_CONNECTOR_ID = crypto.randomUUID();
const LEGACY_CONNECTION_ID = crypto.randomUUID();
const LEGACY_SESSION_ID = crypto.randomUUID();
const LEGACY_USER_ID = crypto.randomUUID();

const GROUP_SLUG = 'team-computers';
const TRAVEL_SLUG = 'travel-computer';

beforeAll(async () => {
  await db.execute(sql`alter type kortix.connector_provider add value if not exists 'computer'`);
  projectId = crypto.randomUUID();
  accountId = crypto.randomUUID();
  otherAccountId = crypto.randomUUID();
  await db.insert(accounts).values([
    { accountId, name: `computer-groups-${accountId}` },
    {
      accountId: otherAccountId,
      name: `computer-groups-other-${otherAccountId}`,
    },
  ]);
  await db.insert(projects).values({
    projectId,
    accountId,
    name: `computer-groups-${projectId}`,
    repoUrl: 'https://example.invalid/computer-groups.git',
    metadata: {},
  });
  const inserted = await db
    .insert(tunnelConnections)
    .values([
      {
        accountId,
        name: 'Studio Mac',
        capabilities: ['filesystem', 'shell', 'desktop'],
        status: 'offline',
        lastHeartbeatAt: new Date(),
        machineInfo: {
          platform: 'darwin',
          hostname: 'studio.local',
          arch: 'arm64',
        },
      },
      {
        accountId,
        name: 'Travel Mac',
        capabilities: ['filesystem', 'desktop'],
        status: 'offline',
        lastHeartbeatAt: new Date(),
        machineInfo: {
          platform: 'darwin',
          hostname: 'travel.local',
          arch: 'arm64',
        },
      },
      {
        accountId,
        name: 'Unassigned Mac',
        capabilities: ['filesystem'],
        status: 'offline',
        lastHeartbeatAt: new Date(),
      },
      {
        accountId: otherAccountId,
        name: 'Other Account Mac',
        capabilities: ['filesystem'],
        status: 'offline',
        lastHeartbeatAt: new Date(),
      },
    ])
    .returning({
      tunnelId: tunnelConnections.tunnelId,
      name: tunnelConnections.name,
    });
  studioTunnelId = inserted.find((row) => row.name === 'Studio Mac')!.tunnelId;
  travelTunnelId = inserted.find((row) => row.name === 'Travel Mac')!.tunnelId;
  unassignedTunnelId = inserted.find((row) => row.name === 'Unassigned Mac')!.tunnelId;
  crossAccountTunnelId = inserted.find((row) => row.name === 'Other Account Mac')!.tunnelId;

  const created = await dbConnectorRouterDeps.createConnector!(projectId, accountId, {
    slug: GROUP_SLUG,
    name: 'Team computers',
    provider: 'computer',
    tunnel_ids: [studioTunnelId, travelTunnelId],
    create_only: true,
  });
  expect(created.ok).toBe(true);

  await db.insert(connectors).values({
    connectorId: LEGACY_CONNECTOR_ID,
    accountId,
    projectId,
    slug: 'computer',
    name: 'Legacy Computers',
    providerType: 'computer',
    config: { auth: { type: 'none', in: 'header', name: null, prefix: null } },
    authorizationStrategy: 'project',
  });
  await db.insert(connectorActions).values({
    connectorId: LEGACY_CONNECTOR_ID,
    path: 'list_computers',
    name: 'List computers',
    description: 'List connected computers.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'read',
    binding: { kind: 'tunnel', method: 'list_computers' },
  });
  await db.insert(connectorConnections).values({
    connectionId: LEGACY_CONNECTION_ID,
    accountId,
    projectId,
    connectorId: LEGACY_CONNECTOR_ID,
    label: 'Legacy default',
    isDefault: true,
  });
  await db.insert(projectSessions).values({
    sessionId: LEGACY_SESSION_ID,
    accountId,
    projectId,
    branchName: LEGACY_SESSION_ID,
    createdBy: LEGACY_USER_ID,
    connectorBindingsConfigured: true,
  });
  await db.insert(projectSessionConnectorBindings).values({
    sessionId: LEGACY_SESSION_ID,
    accountId,
    projectId,
    connectorAlias: 'computer',
    connectorId: LEGACY_CONNECTOR_ID,
    connectionId: LEGACY_CONNECTION_ID,
    source: 'request',
    createdBy: LEGACY_USER_ID,
  });
});

afterAll(async () => {
  await db
    .delete(projectSessionConnectorBindings)
    .where(eq(projectSessionConnectorBindings.sessionId, LEGACY_SESSION_ID));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, LEGACY_SESSION_ID));
  if (projectId) await db.delete(projects).where(eq(projects.projectId, projectId));
  const tunnelIds = [
    studioTunnelId,
    travelTunnelId,
    unassignedTunnelId,
    crossAccountTunnelId,
  ].filter(Boolean);
  if (tunnelIds.length) {
    await db.delete(tunnelConnections).where(inArray(tunnelConnections.tunnelId, tunnelIds));
  }
  const accountIds = [accountId, otherAccountId].filter(Boolean);
  if (accountIds.length) await db.delete(accounts).where(inArray(accounts.accountId, accountIds));
});

describe('grouped Computers connector profiles — real DB', () => {
  test('stores one regular connector with two assigned machine ids and the full catalog', async () => {
    const [row] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, GROUP_SLUG)));
    expect(row?.providerType).toBe('computer');
    expect((row?.config as Record<string, unknown>).tunnel_ids).toEqual([
      studioTunnelId,
      travelTunnelId,
    ]);
    expect((row?.config as Record<string, unknown>).computer_profile).toBe(true);

    const actions = await db
      .select()
      .from(connectorActions)
      .where(eq(connectorActions.connectorId, row!.connectorId));
    expect(actions.some((action) => action.path === 'list_computers')).toBe(true);
    expect(actions.some((action) => action.path === 'fs.read')).toBe(true);
    const read = actions.find((action) => action.path === 'fs.read')!;
    expect(
      (read.inputSchema as { properties?: Record<string, unknown> }).properties?.computer,
    ).toBeDefined();
  });

  test('sync synthesis reads the stored profile instead of generating one connector per tunnel', async () => {
    const specs = await synthesizeComputerConnectors(projectId, []);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.slug).toBe(GROUP_SLUG);
    expect(specs[0]?.tunnelIds).toEqual([studioTunnelId, travelTunnelId]);
  });

  test('config returns the selected machines through the normal connector API model', async () => {
    const config = await dbConnectorRouterDeps.getConnectorConfig!(projectId, GROUP_SLUG);
    expect(config?.provider).toBe('computer');
    expect(config?.tunnelIds).toEqual([studioTunnelId, travelTunnelId]);
  });

  test('list_computers returns only machines assigned to the profile', async () => {
    const result = await executeComputerCall({
      accountId,
      projectId,
      allowedTunnelIds: [studioTunnelId, travelTunnelId],
      selector: null,
      method: 'list_computers',
      args: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = (result.data as { computers: Array<{ id: string }> }).computers.map(
      (computer) => computer.id,
    );
    expect(ids.sort()).toEqual([studioTunnelId, travelTunnelId].sort());
    expect(ids).not.toContain(unassignedTunnelId);
  });

  test('assigned selection reaches tunnel authorization while unassigned selection fails first', async () => {
    const assigned = await executeComputerCall({
      accountId,
      projectId,
      allowedTunnelIds: [studioTunnelId, travelTunnelId],
      selector: studioTunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    expect(assigned.ok).toBe(false);
    if (!assigned.ok) expect(assigned.kind).toBe('permission_required');

    const unassigned = await executeComputerCall({
      accountId,
      projectId,
      allowedTunnelIds: [studioTunnelId, travelTunnelId],
      selector: unassignedTunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    expect(unassigned.ok).toBe(false);
    if (!unassigned.ok) {
      expect(unassigned.kind).toBe('no_machine');
      expect(unassigned.message).toContain('not assigned');
    }
  });

  test('a cross-account id in a forged allowlist still fails closed', async () => {
    const result = await executeComputerCall({
      accountId,
      projectId,
      allowedTunnelIds: [crossAccountTunnelId],
      selector: crossAccountTunnelId,
      method: 'fs.read',
      args: { path: '/x' },
    });
    expect(result).toEqual({
      ok: false,
      kind: 'no_machine',
      message: 'No machines are assigned to this Computers connector profile.',
    });
  });

  test('legacy aggregate is hidden from admin and unbound project principals', async () => {
    const admin = await dbConnectorRouterDeps.listConnectors(projectId);
    expect(admin.map((connector) => connector.slug)).not.toContain('computer');

    const principal = {
      userId: LEGACY_USER_ID,
      accountId,
      projectId,
      sessionId: null,
      subject: { userId: LEGACY_USER_ID, groupIds: [] },
      agentGrant: null,
    };
    const catalog = await dbConnectorRouterDeps.listCatalog(principal);
    expect(catalog.map((connector) => connector.slug)).not.toContain('computer');
    const deps = dbConnectorRouterDeps.makeGatewayDeps(principal);
    expect(await deps.loadConnectorBySlug(projectId, 'computer')).toBeNull();
  });

  test('legacy aggregate remains callable only for its exact durable session binding', async () => {
    const principal = {
      userId: LEGACY_USER_ID,
      accountId,
      projectId,
      sessionId: LEGACY_SESSION_ID,
      subject: { userId: LEGACY_USER_ID, groupIds: [] },
      agentGrant: null,
    };
    const catalog = await dbConnectorRouterDeps.listCatalog(principal);
    expect(catalog.map((connector) => connector.slug)).toContain('computer');
    const deps = dbConnectorRouterDeps.makeGatewayDeps(principal);
    expect(await deps.loadConnectorBySlug(projectId, 'computer')).toMatchObject({
      connectorId: LEGACY_CONNECTOR_ID,
      tunnelIds: null,
    });
  });

  test('multiple profiles can overlap and keep independent policies', async () => {
    const created = await dbConnectorRouterDeps.createConnector!(projectId, accountId, {
      slug: TRAVEL_SLUG,
      name: 'Travel computer',
      provider: 'computer',
      tunnel_ids: [travelTunnelId],
      create_only: true,
    });
    expect(created.ok).toBe(true);
    const policyWrite = await dbConnectorRouterDeps.setConnectorPolicies!(
      projectId,
      accountId,
      TRAVEL_SLUG,
      [{ match: 'fs.read', action: 'block' }],
    );
    expect(policyWrite.ok).toBe(true);

    const groupPolicies = await dbConnectorRouterDeps.getConnectorPolicies!(projectId, GROUP_SLUG);
    const travelPolicies = await dbConnectorRouterDeps.getConnectorPolicies!(
      projectId,
      TRAVEL_SLUG,
    );
    expect(groupPolicies?.policies).toEqual([]);
    expect(travelPolicies?.policies).toEqual([{ match: 'fs.read', action: 'block' }]);
  });

  test('updating a profile replaces its allowlist without changing its policy rows', async () => {
    const updated = await dbConnectorRouterDeps.createConnector!(projectId, accountId, {
      slug: TRAVEL_SLUG,
      name: 'Travel and studio',
      provider: 'computer',
      tunnel_ids: [travelTunnelId, studioTunnelId],
    });
    expect(updated.ok).toBe(true);
    const config = await dbConnectorRouterDeps.getConnectorConfig!(projectId, TRAVEL_SLUG);
    expect(config?.tunnelIds).toEqual([travelTunnelId, studioTunnelId]);
    const [policy] = await db
      .select()
      .from(connectorPolicies)
      .innerJoin(connectors, eq(connectors.connectorId, connectorPolicies.connectorId))
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, TRAVEL_SLUG)));
    expect(policy?.connector_policies.action).toBe('block');
  });

  test('connector calls remain authoritative connector audit events', async () => {
    await db.insert(tunnelPermissions).values({
      tunnelId: studioTunnelId,
      accountId,
      capability: 'filesystem',
      scope: {},
      status: 'active',
    });
    await executeComputerCall({
      accountId,
      projectId,
      allowedTunnelIds: [studioTunnelId],
      selector: studioTunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    const rows = await db
      .select({
        action: auditEvents.action,
        authoritativeSource: auditEvents.authoritativeSource,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.projectId, projectId),
          eq(auditEvents.resourceId, studioTunnelId),
          eq(auditEvents.action, 'connector.computer.fs.read'),
        ),
      );
    expect(rows.some((row) => row.authoritativeSource === 'connector')).toBe(true);
  });

  test('deleting one profile leaves the other profile intact', async () => {
    const deleted = await dbConnectorRouterDeps.deleteConnector!(projectId, TRAVEL_SLUG);
    expect(deleted.ok).toBe(true);
    const remaining = await db
      .select({ slug: connectors.slug, config: connectors.config })
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.providerType, 'computer')));
    expect(
      remaining
        .filter(
          (row) => (row.config as Record<string, unknown> | null)?.computer_profile === true,
        )
        .map((row) => row.slug),
    ).toEqual([GROUP_SLUG]);
  });
});
