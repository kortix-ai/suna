/**
 * Real-PostgreSQL proof that unpairing a machine takes its row locks in the
 * order `attachComputerConnection` does: the connector row first, the machine
 * row second.
 *
 * The unpair's delete sets each account's `tunnel_id` NULL. That update
 * re-checks the account's connector with a key-share lock. Taken after the
 * machine row, it waits on an attach that holds the connector and waits for the
 * machine: SQLSTATE 40P01, a 500 on `DELETE /v1/tunnel/connections/:id`. A
 * mocked `db` cannot show that; only two real transactions can.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectorConnections, connectors, projects, tunnelConnections } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { unpairMachine } from '../tunnel/routes/connections';
import { attachComputerConnection } from './computers';
import { ensureComputerConnector } from './sync';

const ACCOUNT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const OTHER_PROJECT_ID = crypto.randomUUID();

afterAll(async () => {
  await db.delete(tunnelConnections).where(eq(tunnelConnections.accountId, ACCOUNT_ID)).catch(() => undefined);
  for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
    await db.delete(projects).where(eq(projects.projectId, projectId)).catch(() => undefined);
  }
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID)).catch(() => undefined);
});

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Unpair lock order' });
  for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
    await db.insert(projects).values({
      projectId, accountId: ACCOUNT_ID, name: `p-${projectId}`, repoUrl: 'https://example.test/r.git',
    });
  }
});

async function pairInto(projectId: string, name: string) {
  const connectorId = await ensureComputerConnector(projectId, ACCOUNT_ID);
  const tunnelId = await db.transaction(async (tx) => {
    const [machine] = await tx
      .insert(tunnelConnections)
      .values({ accountId: ACCOUNT_ID, ownerUserId: USER_ID, name })
      .returning({ tunnelId: tunnelConnections.tunnelId });
    await attachComputerConnection(tx, {
      accountId: ACCOUNT_ID, projectId, connectorId, ownerType: 'member', ownerId: USER_ID,
      tunnelId: machine!.tunnelId, name, createdBy: USER_ID,
    });
    return machine!.tunnelId;
  });
  return { connectorId, tunnelId };
}

describe('unpair vs attach lock order (real PostgreSQL)', () => {
  test('an unpair racing an attach on another connector never deadlocks', async () => {
    const first = await pairInto(PROJECT_ID, 'first');
    const other = await pairInto(OTHER_PROJECT_ID, 'other');
    // The unpaired machine also has an account on the other connector, so the
    // delete's SET NULL update needs that connector's key-share lock.
    await db.insert(connectorConnections).values({
      accountId: ACCOUNT_ID, projectId: OTHER_PROJECT_ID, connectorId: other.connectorId,
      ownerType: 'project', ownerId: null, label: 'shared', status: 'active', tunnelId: first.tunnelId,
      createdBy: USER_ID,
    });
    // The attach holds the OTHER project's connector, then dwells before it
    // asks for the machine. The unpair of that machine starts in the window:
    // it holds the machine row and, on the old order, waits for the connector.
    const attach = db.transaction(async (tx) => {
      await tx.select({ id: connectors.connectorId }).from(connectors)
        .where(eq(connectors.connectorId, other.connectorId)).for('update');
      await tx.execute(sql`select pg_sleep(1.5)`);
      return attachComputerConnection(tx, {
        accountId: ACCOUNT_ID, projectId: OTHER_PROJECT_ID, connectorId: other.connectorId,
        ownerType: 'member', ownerId: USER_ID, tunnelId: first.tunnelId, name: 'first', createdBy: USER_ID,
      });
    });
    await Bun.sleep(300);
    const unpair = unpairMachine(first.tunnelId);
    const [attachResult, unpairResult] = await Promise.allSettled([attach, unpair]);
    expect(unpairResult.status === 'rejected' ? String(unpairResult.reason) : 'ok').toBe('ok');
    expect(attachResult.status === 'rejected' ? String(attachResult.reason) : 'ok').toBe('ok');
    const left = await db.select({ id: tunnelConnections.tunnelId }).from(tunnelConnections)
      .where(eq(tunnelConnections.tunnelId, first.tunnelId));
    expect(left).toEqual([]);
  }, 30_000);
});
