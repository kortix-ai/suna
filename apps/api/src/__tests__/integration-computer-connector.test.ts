/**
 * Real-DB integration coverage for per-machine computer connectors.
 *
 * The suite proves the full control-plane contract below HTTP: heartbeat-based
 * synthesis, one materialized connector per tunnel, immutable routing,
 * independent policies, lifecycle reconciliation, and legacy aggregate
 * compatibility for durable session bindings.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  auditEvents,
  connectorActions,
  connectorConnections,
  connectors,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
  tunnelAuditLogs,
  tunnelConnections,
  tunnelPermissions,
} from '@kortix/db';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { synthesizeComputerConnectors } from '../connectors/computer-materialize';
import { computerConnectorSlug } from '../connectors/computers';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { reconcileComputerConnectors, syncProjectConnectors } from '../connectors/sync';
import { db } from '../shared/db';
import { executeComputerCall, listAccountComputers } from '../tunnel/core/rpc-core';

let projectId = '';
let accountId = '';
let otherAccountId = '';
let firstTunnelId = '';
let secondTunnelId = '';
let neverConnectedTunnelId = '';
let crossAccountTunnelId = '';
let fixtureRoot = '';
let previousGitCacheDir: string | undefined;

const firstSlug = () => computerConnectorSlug(firstTunnelId);
const secondSlug = () => computerConnectorSlug(secondTunnelId);

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

async function sync(): Promise<void> {
  const result = await syncProjectConnectors(projectId, accountId);
  expect(result.errors).toEqual([]);
}

beforeAll(async () => {
  await db.execute(sql`alter type kortix.connector_provider add value if not exists 'computer'`);
  await db.execute(sql`
    alter table kortix.tunnel_connections
      add column if not exists relay_owner_id varchar(255),
      add column if not exists relay_owner_instance varchar(255),
      add column if not exists relay_owner_started_at timestamp with time zone,
      add column if not exists relay_owner_heartbeat_at timestamp with time zone
  `);

  fixtureRoot = await mkdtemp(join(tmpdir(), 'kortix-computer-profiles-'));
  previousGitCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = join(fixtureRoot, 'git-cache');
  const repository = join(fixtureRoot, 'repository');
  mkdirSync(repository, { recursive: true });
  git(['init', '-b', 'main'], repository);
  git(['config', 'user.email', 'computer-connector@kortix.test'], repository);
  git(['config', 'user.name', 'Computer Connector Test'], repository);
  writeFileSync(
    join(repository, 'kortix.yaml'),
    ['kortix_version: 2', 'project:', '  name: Computer Connector Test', ''].join('\n'),
    'utf8',
  );
  git(['add', 'kortix.yaml'], repository);
  git(['commit', '-m', 'initial'], repository);

  projectId = crypto.randomUUID();
  accountId = crypto.randomUUID();
  otherAccountId = crypto.randomUUID();
  await db.insert(accounts).values([
    { accountId, name: `computer-profiles-${accountId}` },
    {
      accountId: otherAccountId,
      name: `computer-profiles-other-${otherAccountId}`,
    },
  ]);
  await db.insert(projects).values({
    projectId,
    accountId,
    name: `computer-profiles-${projectId}`,
    repoUrl: repository,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
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
        name: 'Never Connected',
        capabilities: [],
        status: 'offline',
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

  firstTunnelId = inserted.find((row) => row.name === 'Studio Mac')!.tunnelId;
  secondTunnelId = inserted.find((row) => row.name === 'Travel Mac')!.tunnelId;
  neverConnectedTunnelId = inserted.find((row) => row.name === 'Never Connected')!.tunnelId;
  crossAccountTunnelId = inserted.find((row) => row.name === 'Other Account Mac')!.tunnelId;
});

afterAll(async () => {
  if (projectId) {
    await db
      .delete(projectSessionConnectorBindings)
      .where(eq(projectSessionConnectorBindings.projectId, projectId));
    await db.delete(projectSessions).where(eq(projectSessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.projectId, projectId));
  }
  const tunnelIds = [
    firstTunnelId,
    secondTunnelId,
    neverConnectedTunnelId,
    crossAccountTunnelId,
  ].filter(Boolean);
  if (tunnelIds.length) {
    await db.delete(tunnelConnections).where(inArray(tunnelConnections.tunnelId, tunnelIds));
  }
  const accountIds = [accountId, otherAccountId].filter(Boolean);
  if (accountIds.length) await db.delete(accounts).where(inArray(accounts.accountId, accountIds));
  if (previousGitCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousGitCacheDir;
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe('per-machine computer connectors — real DB', () => {
  test('synthesizes one stable connector profile per heartbeat-bearing tunnel', async () => {
    const specs = await synthesizeComputerConnectors(projectId, []);
    expect(specs).toHaveLength(2);
    expect(specs.map((spec) => spec.slug).sort()).toEqual([firstSlug(), secondSlug()].sort());
    expect(specs.map((spec) => spec.name).sort()).toEqual(['Studio Mac', 'Travel Mac']);
    expect(specs.map((spec) => spec.tunnelId).sort()).toEqual(
      [firstTunnelId, secondTunnelId].sort(),
    );
    expect(specs.every((spec) => spec.provider === 'computer' && spec.auth.type === 'none')).toBe(
      true,
    );
    expect(specs.some((spec) => spec.tunnelId === neverConnectedTunnelId)).toBe(false);
  });

  test('materializes two regular connectors with independent bound configs and catalogs', async () => {
    await sync();
    const rows = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.providerType, 'computer')));
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      const config = row.config as Record<string, unknown>;
      const expectedTunnelId = row.slug === firstSlug() ? firstTunnelId : secondTunnelId;
      expect(config.tunnel_id).toBe(expectedTunnelId);

      const actions = await db
        .select()
        .from(connectorActions)
        .where(eq(connectorActions.connectorId, row.connectorId));
      expect(actions.length).toBeGreaterThan(5);
      expect(actions.some((action) => action.path === 'list_computers')).toBe(false);
      expect(actions.some((action) => action.path === 'fs.read')).toBe(true);
      for (const action of actions) {
        expect((action.binding as { kind: string }).kind).toBe('tunnel');
        const schema = action.inputSchema as {
          properties?: Record<string, unknown>;
        } | null;
        expect(schema?.properties?.computer).toBeUndefined();
      }
    }
  });

  test('settings resolve each synthetic profile as a regular connector', async () => {
    const policies = await dbConnectorRouterDeps.getConnectorPolicies!(projectId, firstSlug());
    expect(policies).not.toBeNull();
    expect(Array.isArray(policies!.policies)).toBe(true);

    const config = await dbConnectorRouterDeps.getConnectorConfig!(projectId, secondSlug());
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('computer');
    expect(config!.slug).toBe(secondSlug());
  });

  test('stores policies and sensitive state independently per machine profile', async () => {
    const policyWrite = await dbConnectorRouterDeps.setConnectorPolicies!(
      projectId,
      accountId,
      firstSlug(),
      [{ match: 'fs.read', action: 'block' }],
    );
    expect(policyWrite.ok).toBe(true);
    const sensitiveWrite = await dbConnectorRouterDeps.setSensitive!(
      projectId,
      accountId,
      firstSlug(),
      true,
    );
    expect(sensitiveWrite.ok).toBe(true);

    await sync();

    const firstPolicies = await dbConnectorRouterDeps.getConnectorPolicies!(projectId, firstSlug());
    const secondPolicies = await dbConnectorRouterDeps.getConnectorPolicies!(
      projectId,
      secondSlug(),
    );
    expect(firstPolicies?.policies).toEqual([{ match: 'fs.read', action: 'block' }]);
    expect(secondPolicies?.policies).toEqual([]);

    const listed = await dbConnectorRouterDeps.listConnectors(projectId);
    expect(listed.find((connector) => connector.slug === firstSlug())?.sensitive).toBe(true);
    expect(listed.find((connector) => connector.slug === secondSlug())?.sensitive).toBe(false);
  });

  test('routes a call only through the connector-bound tunnel', async () => {
    const first = await executeComputerCall({
      accountId,
      projectId,
      tunnelId: firstTunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.kind).toBe('permission_required');

    const second = await executeComputerCall({
      accountId,
      projectId,
      tunnelId: secondTunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.kind).toBe('permission_required');
  });

  test('fails closed for a cross-account or deleted bound tunnel id', async () => {
    const crossAccount = await executeComputerCall({
      accountId,
      tunnelId: crossAccountTunnelId,
      method: 'fs.read',
      args: { path: '/x' },
    });
    expect(crossAccount).toEqual({
      ok: false,
      kind: 'no_machine',
      message: 'This computer is no longer connected',
    });

    const [temporary] = await db
      .insert(tunnelConnections)
      .values({
        accountId,
        name: 'Deleted Mac',
        capabilities: ['filesystem'],
        status: 'offline',
        lastHeartbeatAt: new Date(),
      })
      .returning({ tunnelId: tunnelConnections.tunnelId });
    await db.delete(tunnelConnections).where(eq(tunnelConnections.tunnelId, temporary!.tunnelId));
    const deleted = await executeComputerCall({
      accountId,
      tunnelId: temporary!.tunnelId,
      method: 'fs.read',
      args: { path: '/x' },
    });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.kind).toBe('no_machine');
  });

  test('keeps permissions and audit isolated to the selected profile', async () => {
    await db.insert(tunnelPermissions).values({
      tunnelId: firstTunnelId,
      accountId,
      capability: 'filesystem',
      scope: {},
      status: 'active',
    });
    const first = await executeComputerCall({
      accountId,
      projectId,
      tunnelId: firstTunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.kind).toBe('error');

    const second = await executeComputerCall({
      accountId,
      projectId,
      tunnelId: secondTunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.kind).toBe('permission_required');

    const audits = await db
      .select({
        tunnelId: tunnelAuditLogs.tunnelId,
        phase: tunnelAuditLogs.phase,
      })
      .from(tunnelAuditLogs)
      .where(eq(tunnelAuditLogs.operation, 'fs.read'));
    expect(audits.some((row) => row.tunnelId === firstTunnelId && row.phase === 'failed')).toBe(
      true,
    );
    expect(audits.some((row) => row.tunnelId === secondTunnelId)).toBe(false);

    const centralized = await db
      .select({
        authoritativeSource: auditEvents.authoritativeSource,
        action: auditEvents.action,
        resourceId: auditEvents.resourceId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.projectId, projectId),
          eq(auditEvents.resourceId, firstTunnelId),
          eq(auditEvents.action, 'connector.computer.fs.read'),
        ),
      );
    expect(centralized.some((row) => row.authoritativeSource === 'connector')).toBe(true);
  });

  test('rename updates profile names and delete removes only that profile', async () => {
    await db
      .update(tunnelConnections)
      .set({ name: 'Renamed Studio Mac' })
      .where(eq(tunnelConnections.tunnelId, firstTunnelId));
    await reconcileComputerConnectors(accountId);

    const [renamed] = await db
      .select({ name: connectors.name })
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, firstSlug())));
    expect(renamed?.name).toBe('Renamed Studio Mac');

    await db.delete(tunnelConnections).where(eq(tunnelConnections.tunnelId, secondTunnelId));
    await reconcileComputerConnectors(accountId);
    const remaining = await db
      .select({ slug: connectors.slug })
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.providerType, 'computer')));
    expect(remaining.map((row) => row.slug)).toEqual([firstSlug()]);
    secondTunnelId = '';
  });

  test('retains the aggregate selector only for legacy durable bindings', async () => {
    const sessionId = `legacy-computer-${crypto.randomUUID()}`;
    const [aggregate] = await db
      .insert(connectors)
      .values({
        accountId,
        projectId,
        slug: 'computer',
        name: 'Computers',
        providerType: 'computer',
        enabled: false,
        status: 'disabled',
        config: {},
      })
      .returning({ connectorId: connectors.connectorId });
    const [connection] = await db
      .insert(connectorConnections)
      .values({
        accountId,
        projectId,
        connectorId: aggregate!.connectorId,
        label: 'Computers',
        isDefault: true,
      })
      .returning({ connectionId: connectorConnections.connectionId });
    await db.insert(projectSessions).values({
      sessionId,
      accountId,
      projectId,
      branchName: `session/${sessionId}`,
      connectorBindingsConfigured: true,
    });
    await db.insert(projectSessionConnectorBindings).values({
      sessionId,
      accountId,
      projectId,
      connectorAlias: 'computer',
      connectorId: aggregate!.connectorId,
      connectionId: connection!.connectionId,
    });

    await sync();

    const [preserved] = await db
      .select({ enabled: connectors.enabled, status: connectors.status })
      .from(connectors)
      .where(eq(connectors.connectorId, aggregate!.connectorId));
    expect(preserved).toEqual({ enabled: true, status: 'active' });

    const adminConnectors = await dbConnectorRouterDeps.listConnectors(projectId);
    expect(adminConnectors.some((connector) => connector.slug === 'computer')).toBe(false);

    const listed = await executeComputerCall({
      accountId,
      tunnelId: null,
      method: 'list_computers',
      args: {},
    });
    expect(listed.ok).toBe(true);
    const machines = await listAccountComputers(accountId);
    expect(machines.some((machine) => machine.id === firstTunnelId)).toBe(true);

    const selected = await executeComputerCall({
      accountId,
      tunnelId: null,
      selector: firstTunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    expect(selected.ok).toBe(false);
    if (!selected.ok) expect(selected.kind).toBe('error');
  });
});
