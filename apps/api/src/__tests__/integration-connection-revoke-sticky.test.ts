/**
 * A connector connection's revoke sticks against writes that started before
 * it (real PostgreSQL).
 *
 * Every `-> active` writer used to write `WHERE connection_id = ?` only. An
 * OAuth callback whose sign-in tab was still open, a device-flow poll, or a
 * Composio finalize that completed after an offboarding or a person's
 * Disconnect wrote `revoked -> active` and stored a fresh token. The status
 * writes now live in `connectors/connection-status.ts`: an in-flight
 * completion re-activates a revoked account only when its flow started after
 * the revoke, and a person's request-time reconnect still works.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { connectionCredentials, connectorConnections, connectors } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { upsertConnectionCredential } from '../connectors/credentials';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';
import { interleave } from './helpers/interleave';

const seeded: SeededProject[] = [];

afterAll(async () => {
  await removeSeeded(seeded);
});

async function seedConnection(label: string, status: 'active' | 'revoked', revokedAt?: Date) {
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
    status,
    metadata: revokedAt ? { revokedAt: revokedAt.toISOString() } : {},
  });
  return { projectId: project_id, connectorId, connectionId };
}

async function state(connectionId: string) {
  const [row] = await db
    .select({ status: connectorConnections.status })
    .from(connectorConnections)
    .where(eq(connectorConnections.connectionId, connectionId));
  const credentials = await db
    .select({ id: connectionCredentials.credentialId })
    .from(connectionCredentials)
    .where(eq(connectionCredentials.connectionId, connectionId));
  return { status: row?.status, credentials: credentials.length };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('a connector connection revoke is sticky', () => {
  test('an OAuth completion that started before the revoke stores nothing and stays revoked', async () => {
    const conn = await seedConnection('revoke-sticky-late', 'revoked', minutesAgo(1));
    await expect(
      upsertConnectionCredential({ ...conn, value: 'late-token', kind: 'oauth2_delegated', startedAt: minutesAgo(5) }),
    ).rejects.toThrow(/revoked/);
    expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
  });

  test('a completion in flight while the revoke commits loses to it', async () => {
    const conn = await seedConnection('revoke-sticky-race', 'active');
    const started = minutesAgo(1);
    const outcome = await interleave(
      (tx) =>
        tx.query(
          `UPDATE kortix.connector_connections
              SET status = 'revoked', metadata = metadata || jsonb_build_object('revokedAt', $2::text)
            WHERE connection_id = $1`,
          [conn.connectionId, new Date().toISOString()],
        ),
      () =>
        upsertConnectionCredential({ ...conn, value: 'racing-token', kind: 'oauth2_delegated', startedAt: started })
          .then(() => 'stored' as const)
          .catch(() => 'refused' as const),
      'connector_connections',
    );
    expect(outcome).toBe('refused');
    expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
  });

  test('a sign-in a person started after the revoke reconnects the account', async () => {
    const conn = await seedConnection('revoke-sticky-reconnect', 'revoked', minutesAgo(10));
    await upsertConnectionCredential({ ...conn, value: 'fresh-token', kind: 'oauth2_delegated', startedAt: minutesAgo(1) });
    expect(await state(conn.connectionId)).toEqual({ status: 'active', credentials: 1 });
  });

  test('a credential a person sets now reconnects a revoked account', async () => {
    const conn = await seedConnection('revoke-sticky-manual', 'revoked', minutesAgo(1));
    await upsertConnectionCredential({ ...conn, value: 'pasted-secret' });
    expect(await state(conn.connectionId)).toEqual({ status: 'active', credentials: 1 });
  });
});
