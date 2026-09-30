import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, connectorConnections, projects, tunnelConnections } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { ensureProjectComputer } from './sync';

// Real PostgreSQL only: the property under test is a row-lock interleaving.
const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;
const accountId = '00000000-0000-4000-a000-000000009b01';
const projectId = '00000000-0000-4000-a000-000000009b02';
const userId = '00000000-0000-4000-a000-000000009b03';
const tunnelId = '00000000-0000-4000-a000-000000009b04';

async function cleanup() {
  await db.delete(tunnelConnections).where(eq(tunnelConnections.accountId, accountId));
  await db.delete(projects).where(eq(projects.accountId, accountId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
}

withDb('ensureProjectComputer vs a concurrent tunnel delete', () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(accounts).values({ accountId, name: 'Computer attach race test' });
    await db.insert(projects).values({
      projectId,
      accountId,
      name: 'Computer attach race',
      repoUrl: 'https://github.com/example-org/example.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      status: 'active',
    });
    await db.insert(tunnelConnections).values({ tunnelId, accountId, ownerUserId: userId, name: 'Test machine' });
  });
  afterEach(cleanup);
  afterAll(cleanup);

  test('a tunnel deleted while the attach is in flight is skipped, not a 23503', async () => {
    // T1 deletes the tunnel and holds the row lock. The attach reads the tunnel
    // (the delete is uncommitted), then must not insert a connection for it.
    let commitDelete!: () => void;
    const held = new Promise<void>((resolve) => (commitDelete = resolve));
    let deleted!: () => void;
    const deleteRan = new Promise<void>((resolve) => (deleted = resolve));
    const deleter = db.transaction(async (tx) => {
      await tx.delete(tunnelConnections).where(eq(tunnelConnections.tunnelId, tunnelId));
      deleted();
      await held;
    });
    await deleteRan;
    const attach = ensureProjectComputer(projectId, userId);
    const outcome = attach.then(
      () => 'resolved',
      (error) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    commitDelete();
    await deleter;
    expect(await outcome).toBe('resolved');
    const rows = await db
      .select({ connectionId: connectorConnections.connectionId })
      .from(connectorConnections)
      .where(eq(connectorConnections.accountId, accountId));
    expect(rows).toEqual([]);
  });
});
