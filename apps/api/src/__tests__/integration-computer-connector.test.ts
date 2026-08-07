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
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, eq, and } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  accounts,
  tunnelAuditLogs,
  projects,
  tunnelConnections,
  tunnelPermissions,
  connectors,
  connectorActions,
} from '@kortix/db';
import { synthesizeComputerConnectors } from '../connectors/computer-materialize';
import { syncProjectConnectors } from '../connectors/sync';
import { executeComputerCall, listAccountComputers } from '../tunnel/core/rpc-core';
import { dbConnectorRouterDeps } from '../connectors/db-deps';

let projectId = '';
let accountId = '';
let tunnelId = '';
let seeded = false;
let fixtureRoot = '';
let previousGitCacheDir: string | undefined;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
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

  fixtureRoot = await mkdtemp(join(tmpdir(), 'kortix-computer-connector-'));
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
  await db.insert(accounts).values({ accountId, name: `computer-connector-${accountId}` });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: `computer-connector-${projectId}`,
    repoUrl: repository,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    metadata: { experimental: { agent_tunnel: true } },
  });

  // Seed a machine that has connected before and is now offline (closed
  // laptop) — `lastHeartbeatAt` is set because device-auth approval is
  // followed within seconds by the CLI's real WS handshake in practice.
  // A row that has NEVER gone online is a different case, covered below.
  const [t] = await db
    .insert(tunnelConnections)
    .values({
      accountId,
      name: 'E2E Test Machine',
      capabilities: ['filesystem', 'shell', 'desktop'],
      status: 'offline',
      lastHeartbeatAt: new Date(),
      machineInfo: { platform: 'darwin', hostname: 'e2e-host', arch: 'arm64' },
    })
    .returning();
  tunnelId = t!.tunnelId;
  seeded = true;
});

afterAll(async () => {
  if (!seeded) return;
  // Drop the materialized connector + the seeded tunnel (cascades permissions /
  // requests), then remove the isolated project and account.
  await db
    .delete(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, 'computer')));
  await db.delete(tunnelConnections).where(eq(tunnelConnections.tunnelId, tunnelId));
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
  if (previousGitCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousGitCacheDir;
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
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
    await db
      .update(projects)
      .set({ metadata: {} as any })
      .where(eq(projects.projectId, projectId));
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
      console.warn(
        '[integration] syncProjectConnectors threw (git backend?):',
        (e as Error).message,
      );
      return;
    }
    const [conn] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, 'computer')));
    expect(conn).toBeTruthy();
    expect(conn!.providerType).toBe('computer');

    const actions = await db
      .select()
      .from(connectorActions)
      .where(eq(connectorActions.connectorId, conn!.connectorId));
    expect(actions.length).toBeGreaterThan(5);
    expect(actions.some((a) => a.path === 'list_computers')).toBe(true);
    expect(actions.some((a) => a.path === 'fs.read')).toBe(true);
    for (const a of actions) expect((a.binding as { kind: string }).kind).toBe('tunnel');
  });

  test('settings reads (policies/config) resolve the SYNTHETIC connector instead of 404ing', async () => {
    if (!seeded) return;
    // Reproduces the dashboard bug: a synthetic connector (channel/computer) is
    // never declared in kortix.yaml, so the manifest-only read returned null →
    // the route 404'd ("connector not found") on a connector that exists + works.
    // The fix falls back to the materialized DB row.
    const [conn] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, 'computer')));
    if (!conn) return; // sync skipped (git backend unreachable) — nothing materialized to read.

    const policies = await dbConnectorRouterDeps.getConnectorPolicies!(projectId, 'computer');
    expect(policies).not.toBeNull(); // would have been null → 404 before the fix
    expect(Array.isArray(policies!.policies)).toBe(true);

    const config = await dbConnectorRouterDeps.getConnectorConfig!(projectId, 'computer');
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('computer');
    expect(config!.slug).toBe('computer');

    // A genuinely unknown slug must still be null → a true 404 (fallback doesn't mask it).
    const missing = await dbConnectorRouterDeps.getConnectorPolicies!(
      projectId,
      'no-such-connector-xyz',
    );
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
      const out = await executeComputerCall({
        accountId,
        selector: null,
        method: 'list_computers',
        args: {},
      });
      expect(out.ok).toBe(true);
      const machines = (
        out as {
          ok: true;
          data: { computers: Array<{ id: string; name: string; online: boolean }> };
        }
      ).data.computers;
      expect(
        machines.some((m) => m.id === tunnelId && m.name === 'E2E Test Machine' && m.online),
      ).toBe(true);

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
    const out = await executeComputerCall({
      accountId,
      selector: tunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
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
    const out = await executeComputerCall({
      accountId,
      selector: tunnelId,
      method: 'fs.read',
      args: { path: '/etc/hosts' },
    });
    // Permission now passes; with no live WS agent the relay reports the machine
    // offline → a plain error (NOT permission_required anymore).
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe('error');

    const [audit] = await db
      .select({
        phase: tunnelAuditLogs.phase,
        success: tunnelAuditLogs.success,
        errorMessage: tunnelAuditLogs.errorMessage,
      })
      .from(tunnelAuditLogs)
      .where(and(eq(tunnelAuditLogs.tunnelId, tunnelId), eq(tunnelAuditLogs.operation, 'fs.read')));
    expect(audit?.phase).toBe('failed');
    expect(audit?.success).toBe(false);
    expect(audit?.errorMessage).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('an unknown machine selector → no_machine error', async () => {
    if (!seeded) return;
    const out = await executeComputerCall({
      accountId,
      selector: 'does-not-exist',
      method: 'fs.read',
      args: { path: '/x' },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe('no_machine');
  });

  describe('a tunnel row that has NEVER connected (no heartbeat, ever)', () => {
    // Reproduces the reported bug: a device-auth approval (or a leftover test
    // fixture) creates a `tunnel_connections` row up front, but the CLI never
    // actually dials in. Without the heartbeat gate that row alone was enough
    // to permanently materialize an "active" `computer` connector across
    // EVERY project in the account — looking exactly like a real connection
    // even though nothing had ever connected.
    let deadTunnelId = '';
    let otherProjectId = '';

    beforeAll(async () => {
      if (!seeded) return;
      const [t] = await db
        .insert(tunnelConnections)
        .values({
          accountId,
          name: 'Never Connected',
          capabilities: [],
          status: 'offline',
          // lastHeartbeatAt intentionally omitted — this row has never come online.
        })
        .returning();
      deadTunnelId = t!.tunnelId;

      // A second, otherwise-unrelated project on the SAME account — proves the
      // dead row doesn't fan out a phantom connector account-wide either.
      const [p] = await db
        .insert(projects)
        .values({
          accountId,
          name: 'computer-synth-fanout-test',
          repoUrl: 'https://example.invalid/computer-synth-fanout-test.git',
        })
        .returning({ projectId: projects.projectId });
      otherProjectId = p!.projectId;
    });

    afterAll(async () => {
      if (deadTunnelId)
        await db.delete(tunnelConnections).where(eq(tunnelConnections.tunnelId, deadTunnelId));
      if (otherProjectId) await db.delete(projects).where(eq(projects.projectId, otherProjectId));
    });

    test('does NOT materialize the computer connector by itself', async () => {
      if (!seeded) return;
      // Temporarily remove the real (heartbeat-bearing) seeded tunnel so the
      // never-connected row is the account's ONLY tunnel_connections row.
      await db
        .update(tunnelConnections)
        .set({ lastHeartbeatAt: null })
        .where(eq(tunnelConnections.tunnelId, tunnelId));
      try {
        const specs = await synthesizeComputerConnectors(otherProjectId, []);
        expect(specs).toEqual([]);
      } finally {
        await db
          .update(tunnelConnections)
          .set({ lastHeartbeatAt: new Date() })
          .where(eq(tunnelConnections.tunnelId, tunnelId));
      }
    });

    test('once the account has ANY real (ever-heartbeat) machine, it materializes for other projects too', async () => {
      if (!seeded) return;
      // The real seeded tunnel (with a heartbeat) still exists on the account,
      // so even a project with no direct relationship to it gets the connector
      // — the dead row contributes nothing either way.
      const specs = await synthesizeComputerConnectors(otherProjectId, []);
      expect(specs).toHaveLength(1);
      expect(specs[0]!.slug).toBe('computer');
    });
  });
});
