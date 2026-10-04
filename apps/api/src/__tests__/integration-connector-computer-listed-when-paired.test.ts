/**
 * The admin connector list (`GET /connectors/projects/:id/connectors`,
 * `db-deps.ts` `listConnectors`) must not present a connector with no account
 * as connected (KRTX-1492).
 *
 * The built-in `computer` connector exists on every project before any
 * machine is paired. `hideMachinelessComputers` kept that row "always shown",
 * so a fresh project's Connected tab listed "Computers" as connected while
 * its detail dialog said "No account yet", and the catalogue card carried a
 * connected mark with a Connect CTA behind it. A connector with zero
 * accounts is not a connected connector: it stays out of the list until a
 * machine is paired, and the catalogue's native Computers card carries the
 * Connect CTA in the meantime.
 *
 * Real-Postgres tenant contract — run with DATABASE_URL pointed at an
 * isolated migrated database (mirrors integration-connector-list-member-credential-status.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectorConnections, connectors, projects, accounts, tunnelConnections } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { ensureProjectComputer } from '../connectors/sync';
import { db } from '../lib/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER_A = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'computer-listed-when-paired' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'computer-listed-when-paired',
    repoUrl: 'https://example.test/computer-listed-when-paired.git',
  });
  // The built-in computer connector, as every fresh project gets it: present,
  // machineless. `userId: null` pairs nothing.
  await ensureProjectComputer(PROJECT, null);
});

afterAll(async () => {
  await db.delete(tunnelConnections).where(eq(tunnelConnections.accountId, ACCOUNT));
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const computerConnectorId = async (): Promise<string> => {
  const [row] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(and(eq(connectors.projectId, PROJECT), eq(connectors.providerType, 'computer')))
    .limit(1);
  if (!row) throw new Error('built-in computer connector row is missing');
  return row.connectorId;
};

describe('listConnectors lists the computer connector only when a machine is paired', () => {
  test('a fresh project lists no machineless computer connector', async () => {
    const list = await dbConnectorRouterDeps.listConnectors(PROJECT, USER_A);
    expect(list.filter((view) => view.provider === 'computer')).toEqual([]);
  });

  test('a paired machine lists the connector with the machine as its account', async () => {
    const connectorId = await computerConnectorId();
    const [tunnel] = await db
      .insert(tunnelConnections)
      .values({ accountId: ACCOUNT, ownerUserId: USER_A, name: 'demo-laptop' })
      .returning({ tunnelId: tunnelConnections.tunnelId });
    await db.insert(connectorConnections).values({
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId,
      ownerType: 'member',
      ownerId: USER_A,
      label: 'demo-laptop',
      status: 'active',
      tunnelId: tunnel!.tunnelId,
    });

    const list = await dbConnectorRouterDeps.listConnectors(PROJECT, USER_A);
    const computer = list.filter((view) => view.provider === 'computer');
    expect(computer).toHaveLength(1);
    expect(computer[0]!.status).toBe('active');
    expect(computer[0]!.accounts).toHaveLength(1);
    expect(computer[0]!.accounts![0]!.label).toBe('demo-laptop');
  });
});
