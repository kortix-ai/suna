import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, connectorProjectPolicies, connectorSyncFences, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  connectorScope,
  openConnectorSyncFence,
  PROJECT_POLICY_SCOPE,
  reconcileProjectPolicies,
  withConnectorSyncWrite,
} from './sync';

// Runs against a real PostgreSQL only: the properties under test are
// transaction and row-lock behavior.
const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;
const accountId = '00000000-0000-4000-a000-000000009a01';
const projectId = '00000000-0000-4000-a000-000000009a02';

async function cleanup() {
  await db.delete(projects).where(eq(projects.accountId, accountId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
}

async function projectRules() {
  return db
    .select({ match: connectorProjectPolicies.match, action: connectorProjectPolicies.action })
    .from(connectorProjectPolicies)
    .where(eq(connectorProjectPolicies.projectId, projectId));
}

withDb('connector sync writes', () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(accounts).values({ accountId, name: 'Connector sync fence test' });
    await db.insert(projects).values({
      projectId,
      accountId,
      name: 'Connector sync fence',
      repoUrl: 'https://github.com/example-org/example.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      status: 'active',
    });
    await reconcileProjectPolicies(projectId, {
      policies: [{ match: 'mail.send*', action: 'block' }],
      settings: { defaultMode: 'allow_all' },
    });
  });
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
  });

  test('a project policy replace that fails keeps the previous rules', async () => {
    // `match` is varchar(512): the insert fails after the delete ran.
    await expect(
      reconcileProjectPolicies(projectId, {
        policies: [{ match: `mail.${'x'.repeat(600)}`, action: 'always_run' }],
        settings: { defaultMode: 'allow_all' },
      }),
    ).rejects.toThrow();
    expect(await projectRules()).toEqual([{ match: 'mail.send*', action: 'block' }]);
  });

  test('a sync that started before the last writer of a scope skips that scope', async () => {
    const older = await openConnectorSyncFence(projectId);
    const newer = await openConnectorSyncFence(projectId);
    await reconcileProjectPolicies(
      projectId,
      { policies: [{ match: 'mail.*', action: 'block' }], settings: { defaultMode: 'risk' } },
      newer,
    );
    await reconcileProjectPolicies(projectId, { policies: [], settings: { defaultMode: 'allow_all' } }, older);
    expect(await projectRules()).toEqual([{ match: 'mail.*', action: 'block' }]);
    await expect(withConnectorSyncWrite(older, PROJECT_POLICY_SCOPE, async () => 'written')).resolves.toBeNull();
    const [fence] = await db
      .select({ startedAt: sql<string>`${connectorSyncFences.startedAt}::text` })
      .from(connectorSyncFences)
      .where(eq(connectorSyncFences.projectId, projectId));
    expect(fence?.startedAt).toBe(newer.startedAt);
  });

  test('an older sync still writes a scope the newer sync has not written, so its caller reads its write', async () => {
    const older = await openConnectorSyncFence(projectId);
    const newer = await openConnectorSyncFence(projectId);
    await withConnectorSyncWrite(newer, connectorScope('a'), async () => undefined);
    await expect(withConnectorSyncWrite(older, connectorScope('b'), async () => 'b written')).resolves.toBe(
      'b written',
    );
    await expect(withConnectorSyncWrite(older, connectorScope('a'), async () => 'a written')).resolves.toBeNull();
  });

  test('one sync may write a scope many times', async () => {
    const fence = await openConnectorSyncFence(projectId);
    await withConnectorSyncWrite(fence, connectorScope('x'), async () => undefined);
    await expect(withConnectorSyncWrite(fence, connectorScope('x'), async () => 'second')).resolves.toBe('second');
  });

  test('writes to one scope run one at a time', async () => {
    const first = await openConnectorSyncFence(projectId);
    const second = await openConnectorSyncFence(projectId);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const a = withConnectorSyncWrite(first, connectorScope('same'), async () => {
      order.push('first:start');
      entered();
      await held;
      order.push('first:end');
    });
    await firstEntered;
    const b = withConnectorSyncWrite(second, connectorScope('same'), async () => {
      order.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
