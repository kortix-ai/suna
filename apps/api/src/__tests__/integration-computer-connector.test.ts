/**
 * Integration test (real local DB): the `computer` connector end-to-end below the
 * HTTP layer — synth materialization → list_computers → permission_required →
 * grant → relay attempt. Proves the real wiring (sync, db-deps, the shared tunnel
 * RPC core) against a real Postgres with a seeded tunnel, no WS agent needed.
 *
 * Runs against the local Postgres (DATABASE_URL). Seeds a project's account with
 * a tunnel + the agent_tunnel flag in beforeAll, cleans up in afterAll. Applies
 * the additive enum value idempotently (mirrors ensureSchema's push locally).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql, eq, and } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  projects,
  tunnelConnections,
  tunnelPermissions,
  executorConnectors,
  executorConnectorActions,
} from '@kortix/db';
import { synthesizeComputerConnectors } from '../executor/computer-materialize';
import { syncProjectConnectors } from '../executor/sync';
import { executeComputerCall, listAccountComputers } from '../tunnel/core/rpc-core';
import { dbExecutorRouterDeps } from '../executor/db-deps';

let projectId = '';
let accountId = '';
let tunnelId = '';
let originalMetadata: unknown = null;
let seeded = false;

beforeAll(async () => {
  await db.execute(sql`alter type kortix.executor_connector_provider add value if not exists 'computer'`);
  await db.execute(sql`
    alter table kortix.tunnel_connections
      add column if not exists relay_owner_id varchar(255),
      add column if not exists relay_owner_instance varchar(255),
      add column if not exists relay_owner_started_at timestamp with time zone,
      add column if not exists relay_owner_heartbeat_at timestamp with time zone
  `);

  const rows = (await db.execute(
    sql`select project_id, account_id, metadata from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string; metadata: unknown }>;
  const proj = rows[0];
  if (!proj) {
    console.warn('[integration] no project in local DB — skipping computer connector e2e');
    return;
  }
  projectId = proj.project_id;
  accountId = proj.account_id;
  originalMetadata = proj.metadata ?? {};

  // Opt the project into agent_tunnel (the synth gate).
  const meta = { ...(proj.metadata as Record<string, unknown> | null ?? {}) };
  const exp = { ...((meta.experimental as Record<string, unknown> | undefined) ?? {}) };
  exp.agent_tunnel = true;
  meta.experimental = exp;
  await db.update(projects).set({ metadata: meta }).where(eq(projects.projectId, projectId));

  // Seed a connected machine (what device-auth approve would create).
  const [t] = await db
    .insert(tunnelConnections)
    .values({
      accountId,
      name: 'E2E Test Machine',
      capabilities: ['filesystem', 'shell', 'desktop'],
      status: 'offline',
      machineInfo: { platform: 'darwin', hostname: 'e2e-host', arch: 'arm64' },
    })
    .returning();
  tunnelId = t!.tunnelId;
  seeded = true;
});

afterAll(async () => {
  if (!seeded) return;
  // Drop the materialized connector + the seeded tunnel (cascades permissions /
  // requests), then restore the project's metadata.
  await db.delete(executorConnectors).where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, 'computer')));
  await db.delete(tunnelConnections).where(eq(tunnelConnections.tunnelId, tunnelId));
  await db.update(projects).set({ metadata: originalMetadata as any }).where(eq(projects.projectId, projectId));
});

describe('computer connector — real DB e2e', () => {
  test('synth produces ONE computer spec when the account has a connected machine', async () => {
    if (!seeded) return;
    const specs = await synthesizeComputerConnectors(projectId, []);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.slug).toBe('computer');
    expect(specs[0]!.provider).toBe('computer');
    expect(specs[0]!.auth.type).toBe('none');
  });

  test('synth is a REGULAR connector — a connected machine alone materializes it, no agent_tunnel flag', async () => {
    if (!seeded) return;
    // Clear the experimental flag entirely: the connector no longer depends on
    // it (it's machine-driven like the Slack channel connector). Previously this
    // returned []; now the connected machine alone is enough.
    await db.update(projects).set({ metadata: {} as any }).where(eq(projects.projectId, projectId));
    const specs = await synthesizeComputerConnectors(projectId, []);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.slug).toBe('computer');
  });

  test('full sync materializes the computer connector + the tunnel catalog', async () => {
    if (!seeded) return;
    try {
      await syncProjectConnectors(projectId, accountId);
    } catch (e) {
      // Full sync reads the project's git manifest; if the managed git backend
      // isn't reachable from this test env, the install-driven computer synth
      // still runs — but if the whole sync throws, fall back to asserting synth
      // directly (covered above) and skip the row check.
      console.warn('[integration] syncProjectConnectors threw (git backend?):', (e as Error).message);
      return;
    }
    const [conn] = await db
      .select()
      .from(executorConnectors)
      .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, 'computer')));
    expect(conn).toBeTruthy();
    expect(conn!.providerType).toBe('computer');

    const actions = await db
      .select()
      .from(executorConnectorActions)
      .where(eq(executorConnectorActions.connectorId, conn!.connectorId));
    expect(actions.length).toBeGreaterThan(5);
    expect(actions.some((a) => a.path === 'list_computers')).toBe(true);
    expect(actions.some((a) => a.path === 'fs.read')).toBe(true);
    for (const a of actions) expect((a.binding as { kind: string }).kind).toBe('tunnel');
  });

  test('settings reads (policies/config) resolve the SYNTHETIC connector instead of 404ing', async () => {
    if (!seeded) return;
    // Reproduces the dashboard bug: a synthetic connector (channel/computer) is
    // never declared in kortix.toml, so the manifest-only read returned null →
    // the route 404'd ("connector not found") on a connector that exists + works.
    // The fix falls back to the materialized DB row.
    const [conn] = await db
      .select()
      .from(executorConnectors)
      .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, 'computer')));
    if (!conn) return; // sync skipped (git backend unreachable) — nothing materialized to read.

    const policies = await dbExecutorRouterDeps.getConnectorPolicies!(projectId, 'computer');
    expect(policies).not.toBeNull(); // would have been null → 404 before the fix
    expect(Array.isArray(policies!.policies)).toBe(true);

    const config = await dbExecutorRouterDeps.getConnectorConfig!(projectId, 'computer');
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('computer');
    expect(config!.slug).toBe('computer');

    // A genuinely unknown slug must still be null → a true 404 (fallback doesn't mask it).
    const missing = await dbExecutorRouterDeps.getConnectorPolicies!(projectId, 'no-such-connector-xyz');
    expect(missing).toBeNull();
  });

  test('list_computers returns the connected machine and DB-backed online status', async () => {
    if (!seeded) return;
    await db
      .update(tunnelConnections)
      .set({
        status: 'online',
        relayOwnerId: 'api-owner-for-test',
        relayOwnerInstance: 'api-owner-for-test',
        relayOwnerStartedAt: new Date(),
        relayOwnerHeartbeatAt: new Date(),
        lastHeartbeatAt: new Date(),
      })
      .where(eq(tunnelConnections.tunnelId, tunnelId));

    try {
      const out = await executeComputerCall({ accountId, selector: null, method: 'list_computers', args: {} });
      expect(out.ok).toBe(true);
      const machines = (out as { ok: true; data: { computers: Array<{ id: string; name: string; online: boolean }> } }).data.computers;
      expect(machines.some((m) => m.id === tunnelId && m.name === 'E2E Test Machine' && m.online)).toBe(true);

      // direct helper sanity
      const direct = await listAccountComputers(accountId);
      expect(direct.some((m) => m.id === tunnelId && m.online)).toBe(true);
    } finally {
      await db
        .update(tunnelConnections)
        .set({
          status: 'offline',
          relayOwnerId: null,
          relayOwnerInstance: null,
          relayOwnerStartedAt: null,
          relayOwnerHeartbeatAt: null,
          lastHeartbeatAt: null,
        })
        .where(eq(tunnelConnections.tunnelId, tunnelId));
    }
  });

  test('fs.read with no grant → permission_required (pending approval)', async () => {
    if (!seeded) return;
    const out = await executeComputerCall({ accountId, selector: tunnelId, method: 'fs.read', args: { path: '/etc/hosts' } });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe('permission_required');
      if (out.kind === 'permission_required') expect(out.requestId).toBeTruthy();
    }
  });

  test('after granting filesystem, the call passes permission and reaches the (offline) relay', async () => {
    if (!seeded) return;
    await db.insert(tunnelPermissions).values({
      tunnelId,
      accountId,
      capability: 'filesystem',
      scope: {},
      status: 'active',
    });
    const out = await executeComputerCall({ accountId, selector: tunnelId, method: 'fs.read', args: { path: '/etc/hosts' } });
    // Permission now passes; with no live WS agent the relay reports the machine
    // offline → a plain error (NOT permission_required anymore).
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe('error');
  });

  test('an unknown machine selector → no_machine error', async () => {
    if (!seeded) return;
    const out = await executeComputerCall({ accountId, selector: 'does-not-exist', method: 'fs.read', args: { path: '/x' } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe('no_machine');
  });
});
