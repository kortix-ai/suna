/**
 * Real-PostgreSQL race contract for `upsertConnectionCredential`.
 *
 * Two concurrent writes for one connection (an OAuth completion opened twice,
 * the setup-link finalize poll, device-flow polling) must both succeed and
 * land in exactly one row. `connection_credentials` carries a partial unique
 * index on (connection_id); the upsert used to be a check-then-write fork, so
 * the loser's INSERT raised 23505 — which `completeAuthorizationCodeSession`
 * swallows and turns into a `status='error'` flip on a connection whose
 * authorization in fact completed (surfaced as `token_exchange_failed`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { connectionCredentials, connectorConnections, connectors } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { upsertConnectionCredential } from '../connectors/credentials';
import { decryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const seeded: SeededProject[] = [];

afterAll(async () => {
  await removeSeeded(seeded);
});

async function seedConnection(label: string): Promise<{
  projectId: string;
  connectorId: string;
  connectionId: string;
}> {
  const { account_id, project_id } = await seedProject(label);
  seeded.push({ account_id, project_id });
  const connectorId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  await db.insert(connectors).values({
    connectorId,
    accountId: account_id,
    projectId: project_id,
    slug: label,
    name: label,
    providerType: 'http',
    config: { baseUrl: 'https://example.test', auth: { type: 'bearer' } },
  });
  await db.insert(connectorConnections).values({
    connectionId,
    accountId: account_id,
    projectId: project_id,
    connectorId,
    label,
    metadata: {},
  });
  return { projectId: project_id, connectorId, connectionId };
}

const storedValue = async (connectionId: string, projectId: string): Promise<string[]> =>
  (
    await db
      .select({ valueEnc: connectionCredentials.valueEnc })
      .from(connectionCredentials)
      .where(eq(connectionCredentials.connectionId, connectionId))
  ).map((row) => decryptProjectSecret(projectId, row.valueEnc));

describe('upsertConnectionCredential under concurrency', () => {
  test('every concurrent writer succeeds and one row keeps the last write', async () => {
    const conn = await seedConnection('credential-upsert-race');

    const writers = Array.from({ length: 8 }, (_, i) =>
      upsertConnectionCredential({ ...conn, value: `race-value-${i}` }),
    );
    await Promise.all(writers);

    // The winner is whichever write committed last: any of the 8 values, one row.
    const values = await storedValue(conn.connectionId, conn.projectId);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/^race-value-\d$/);
  });

  test('a sequential double-upsert updates the row in place', async () => {
    const conn = await seedConnection('credential-upsert-sequence');

    await upsertConnectionCredential({ ...conn, value: 'first-value', createdBy: null });
    await upsertConnectionCredential({ ...conn, value: 'second-value' });

    const values = await storedValue(conn.connectionId, conn.projectId);
    expect(values).toEqual(['second-value']);
  });
});
