/**
 * A connector whose catalog is built from code (computer, channel) is
 * rewritten only when that catalog changes.
 *
 * 2026-10-30, prod: every connector sweep pass deleted and re-inserted all
 * 51,732 computer action rows (each one younger than the ~45 min sweep cycle)
 * although the catalog never changed. The stored hash now covers the built
 * catalog, so an unchanged one is reused like a fetched catalog is.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, connectorActions, connectors, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { ensureProjectComputer, syncProjectConnectors } from './sync';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
let connectorId = '';

const actionIds = async () =>
  (await db.select({ actionId: connectorActions.actionId }).from(connectorActions).where(eq(connectorActions.connectorId, connectorId)))
    .map((row) => row.actionId)
    .sort();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'sync-built-catalog' });
  // No reachable repository: the sync still materializes the computer connector.
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'sync-built-catalog',
    repoUrl: 'https://example.invalid/sync-built-catalog.git',
  });
  await ensureProjectComputer(PROJECT, null);
  const [row] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(and(eq(connectors.projectId, PROJECT), eq(connectors.providerType, 'computer')));
  connectorId = row!.connectorId;
});

afterAll(async () => {
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

test('an unchanged computer catalog keeps its action rows across syncs', async () => {
  const before = await actionIds();
  expect(before.length).toBeGreaterThan(0);

  await syncProjectConnectors(PROJECT, ACCOUNT);
  await syncProjectConnectors(PROJECT, ACCOUNT);

  expect(await actionIds()).toEqual(before);
});

test('a computer catalog stored under another hash is materialized again', async () => {
  const before = await actionIds();
  // The row an older API wrote: its hash does not cover today's catalog.
  await db.update(connectors).set({ manifestHash: 'f'.repeat(64) }).where(eq(connectors.connectorId, connectorId));

  await syncProjectConnectors(PROJECT, ACCOUNT);

  const after = await actionIds();
  expect(after).toHaveLength(before.length);
  expect(after).not.toEqual(before);
  const [row] = await db.select({ manifestHash: connectors.manifestHash }).from(connectors).where(eq(connectors.connectorId, connectorId));
  expect(row!.manifestHash).not.toBe('f'.repeat(64));
});
