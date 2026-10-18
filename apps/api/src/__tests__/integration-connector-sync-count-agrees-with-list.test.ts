/**
 * The sync summary must agree with the connector list (KRTX-2669).
 *
 * `kortix connectors sync` printed "Synced 2 connectors" while
 * `kortix connectors ls` listed exactly 1: the loop counted the built-in
 * machineless `computer` connector it re-upserts for catalog freshness,
 * while the admin list (`listConnectors`) hides machineless computers
 * (KRTX-1492). A success summary that disagrees with the tool's own
 * listing reads as either a wrong count or an invisible second connector.
 *
 * The contract pinned here: `result.synced` counts exactly the connectors
 * `listConnectors` lists — declared + channel + PAIRED computers, never a
 * machineless one. Paired computers must keep counting (second test), so
 * the fix cannot simply exclude the provider.
 *
 * Real-Postgres tenant contract — run with DATABASE_URL pointed at an
 * isolated migrated database (mirrors
 * integration-connector-computer-listed-when-paired.test.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectorConnections, connectors, projects, accounts, tunnelConnections } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { ensureProjectComputer, syncProjectConnectors } from '../connectors/sync';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER_A = crypto.randomUUID();

let root = '';
let remote = '';

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('sync-count: DATABASE_URL is required (local Postgres)');
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'sync-count-agrees' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'sync-count-agrees',
    repoUrl: 'https://example.invalid/sync-count-agrees.git',
  });
  await ensureProjectComputer(PROJECT, null);
});

afterAll(async () => {
  await db.delete(tunnelConnections).where(eq(tunnelConnections.accountId, ACCOUNT));
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const pairMachine = async (): Promise<void> => {
  const [computer] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(and(eq(connectors.projectId, PROJECT), eq(connectors.providerType, 'computer')))
    .limit(1);
  const [tunnel] = await db
    .insert(tunnelConnections)
    .values({ accountId: ACCOUNT, ownerUserId: USER_A, name: 'qa-laptop' })
    .returning({ tunnelId: tunnelConnections.tunnelId });
  await db.insert(connectorConnections).values({
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorId: computer!.connectorId,
    ownerType: 'member',
    ownerId: USER_A,
    label: 'qa-laptop',
    status: 'active',
    tunnelId: tunnel!.tunnelId,
  });
};

describe('syncProjectConnectors summary agrees with listConnectors', () => {
  test('a machineless computer connector is re-upserted but not counted', async () => {
    // The exact dev repro shape: one declared connector + the machineless
    // built-in computer connector. The manifest is unreachable
    // (example.invalid), so only the computer spec syncs — the old loop
    // counted it (synced: 1) while the list shows nothing.
    const result = await syncProjectConnectors(PROJECT, ACCOUNT);
    const list = await dbConnectorRouterDeps.listConnectors(PROJECT, USER_A);
    expect(result.synced).toBe(list.length);
    expect(list).toHaveLength(0);
  });

  test('a declared connector counts, and the count equals the list on every sync', async () => {
    // A real bare upstream on disk; the API's mirror clones it over file://
    // (same pattern as integration-project-snapshot.test.ts).
    root = mkdtempSync(join(tmpdir(), 'kortix-sync-count-'));
    remote = join(root, 'remote.git');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q', '--bare', '-b', 'main', remote);
    const work = join(root, 'work');
    git('clone', '-q', remote, work);
    writeFileSync(
      join(work, 'kortix.yaml'),
      [
        'kortix_version: 2',
        'connectors:',
        '  - slug: qa-mcp',
        '    provider: mcp',
        '    url: http://127.0.0.1:9/mcp',
        '',
      ].join('\n'),
    );
    execFileSync('git', ['add', '-A'], { cwd: work });
    execFileSync('git', ['commit', '-q', '-m', 'declare qa-mcp'], { cwd: work });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });
    await db
      .update(projects)
      .set({ repoUrl: remote })
      .where(eq(projects.projectId, PROJECT));

    const result = await syncProjectConnectors(PROJECT, ACCOUNT);
    const list = await dbConnectorRouterDeps.listConnectors(PROJECT, USER_A);
    expect(result.synced).toBe(list.length);
    // The declared connector is listed exactly once; the machineless
    // computer connector stays invisible to both.
    expect(list.map((view) => view.slug).sort()).toEqual(['qa-mcp']);

    // Idempotent second sync — the reported mismatch was 2/2.
    const again = await syncProjectConnectors(PROJECT, ACCOUNT);
    expect(again.synced).toBe(list.length);
  });

  test('a paired machine counts: the computer connector is listed and synced', async () => {
    await pairMachine();
    const result = await syncProjectConnectors(PROJECT, ACCOUNT);
    const list = await dbConnectorRouterDeps.listConnectors(PROJECT, USER_A);
    expect(result.synced).toBe(list.length);
    expect(list.map((view) => view.slug).sort()).toEqual(['computer', 'qa-mcp']);
  });
});
