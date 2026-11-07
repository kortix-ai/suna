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
import {
  connectionCredentials,
  connectionOAuthApplications,
  connectionOAuthSessions,
  connectorConnections,
  connectors,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { upsertConnectionCredential } from '../connectors/credentials';
import { completeConnection, connectConnection, revokeConnections } from '../connectors/connection-status';
import { pollDeviceAuthorizationSession } from '../connectors/oauth2-store';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';
import { interleave } from './helpers/interleave';

const seeded: SeededProject[] = [];

afterAll(async () => {
  await removeSeeded(seeded);
});

async function seedConnection(
  label: string,
  status: 'active' | 'revoked',
  /** Unset: no `revokedAt` key. A string: a malformed stamp. */
  revokedAt?: Date | string,
) {
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
    metadata:
      revokedAt === undefined
        ? {}
        : { revokedAt: revokedAt instanceof Date ? revokedAt.toISOString() : revokedAt },
  });
  return { accountId: account_id, projectId: project_id, connectorId, connectionId };
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
/** Who started the device flow: a real member id, a uuid column. */
const DEVICE_FLOW_MEMBER = crypto.randomUUID();

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

  test('a revoke with no recorded time stays revoked against a completion that started after it', async () => {
    // The 2026-09-17 migration set `status = 'revoked'` without a `revokedAt`.
    // A missing stamp is not the epoch, so no completion is trusted to be newer.
    const conn = await seedConnection('revoke-sticky-unstamped', 'revoked');
    expect(await completeConnection(conn.connectionId, minutesAgo(5))).toBe(false);
    await expect(
      upsertConnectionCredential({ ...conn, value: 'stale-token', kind: 'oauth2_delegated', startedAt: minutesAgo(5) }),
    ).rejects.toThrow(/revoked/);
    expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
  });

  test('a malformed revoke time keeps the account revoked', async () => {
    const conn = await seedConnection('revoke-sticky-malformed', 'revoked', 'not-a-date');
    expect(await completeConnection(conn.connectionId, minutesAgo(5))).toBe(false);
    await expect(
      upsertConnectionCredential({ ...conn, value: 'stale-token', kind: 'oauth2_delegated', startedAt: minutesAgo(5) }),
    ).rejects.toThrow(/revoked/);
    expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
  });

  test('a revoke recorded after the flow started keeps the account revoked', async () => {
    const conn = await seedConnection('revoke-sticky-after', 'revoked', minutesAgo(1));
    await expect(
      upsertConnectionCredential({ ...conn, value: 'token', kind: 'oauth2_delegated', startedAt: minutesAgo(5) }),
    ).rejects.toThrow(/revoked/);
    expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
  });

  test('a revoke through revokeConnections keeps the account revoked', async () => {
    const conn = await seedConnection('revoke-sticky-helper', 'active');
    await revokeConnections(eq(connectorConnections.connectionId, conn.connectionId));
    await expect(
      upsertConnectionCredential({ ...conn, value: 'stale-token', kind: 'oauth2_delegated', startedAt: minutesAgo(1) }),
    ).rejects.toThrow(/revoked/);
    expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
  });

  test('a sign-in a person started after the revoke reconnects the account', async () => {
    const conn = await seedConnection('revoke-sticky-reconnect', 'revoked', minutesAgo(10));
    await upsertConnectionCredential({ ...conn, value: 'fresh-token', kind: 'oauth2_delegated', startedAt: minutesAgo(1) });
    expect(await state(conn.connectionId)).toEqual({ status: 'active', credentials: 1 });
  });

  test('a completion that names no start (a hosted-connect finalize) never leaves revoked', async () => {
    const conn = await seedConnection('revoke-sticky-finalize', 'revoked', minutesAgo(1));
    await expect(upsertConnectionCredential({ ...conn, value: 'acct_upstream', kind: 'connection' })).rejects.toThrow(/revoked/);
    expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
  });

  test('a credential a person sets now reconnects a revoked account', async () => {
    const conn = await seedConnection('revoke-sticky-manual', 'revoked', minutesAgo(1));
    await upsertConnectionCredential({ ...conn, value: 'pasted-secret', connectNow: true });
    expect(await state(conn.connectionId)).toEqual({ status: 'active', credentials: 1 });
  });

  test('a person reconnects an account whose revoke was never stamped', async () => {
    const conn = await seedConnection('revoke-sticky-manual-unstamped', 'revoked');
    await upsertConnectionCredential({ ...conn, value: 'pasted-secret', connectNow: true });
    expect(await state(conn.connectionId)).toEqual({ status: 'active', credentials: 1 });
  });

  test('an agent starting its own authorization does not revive a revoked account', async () => {
    // The connector-scoped `/connect` route lets an agent session start with
    // `owner: "me"`, and it lands on the member's row even when revoked. A
    // revoke is a person's decision: an agent records its authorization on the
    // row and the row stays revoked until the flow completes after the revoke.
    const conn = await seedConnection('revoke-sticky-agent-start', 'revoked', minutesAgo(10));
    const applications = await db
      .insert(connectionOAuthApplications)
      .values({ ...conn, configEnc: 'not-used-by-this-test' })
      .returning({ applicationId: connectionOAuthApplications.applicationId });
    const pending = await db
      .insert(connectionOAuthSessions)
      .values({
        applicationId: applications[0].applicationId,
        accountId: conn.accountId,
        projectId: conn.projectId,
        connectionId: conn.connectionId,
        // The member (owner) started the flow; `connectConnection` runs for them.
        initiatedBy: DEVICE_FLOW_MEMBER,
        flow: 'device_authorization',
        deviceCodeEnc: 'not-used-by-this-test',
        expiresAt: new Date(Date.now() + 600_000),
      })
      .returning({ sessionId: connectionOAuthSessions.sessionId });
    expect(await connectConnection(conn.connectionId, { metadata: { session_id: 'sess_1' } })).toBeNull();
    // Denied: the agent's start expires the session waiting on the account, so
    // the poll never asks the provider and never stores a token on it.
    const sessions = await db
      .select({ status: connectionOAuthSessions.status })
      .from(connectionOAuthSessions)
      .where(eq(connectionOAuthSessions.sessionId, pending[0].sessionId));
    expect(sessions[0].status).toBe('expired');
    expect(await pollDeviceAuthorizationSession({
      sessionId: pending[0].sessionId,
      connectionId: conn.connectionId,
      initiatedBy: DEVICE_FLOW_MEMBER,
    })).toEqual({ status: 'expired' });
    expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
  });

  test('an agent finishing a flow that recorded no start never stores it on a revoked account', async () => {
    // A hosted-connect finalize reports no start. It cannot prove the flow
    // began after the revoke, so it loses — with a stamp or without one.
    for (const revokedAt of [undefined, minutesAgo(1)]) {
      const conn = await seedConnection(`revoke-sticky-finish-${revokedAt ? 'stamped' : 'unstamped'}`, 'revoked', revokedAt);
      expect(await completeConnection(conn.connectionId, null)).toBe(false);
      expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
    }
  });

  test('a completion that started at the exact instant of the revoke loses to it', async () => {
    const revokedAt = minutesAgo(5);
    const conn = await seedConnection('revoke-sticky-tie', 'revoked', revokedAt);
    expect(await completeConnection(conn.connectionId, new Date(revokedAt.getTime()))).toBe(false);
    expect(await state(conn.connectionId)).toEqual({ status: 'revoked', credentials: 0 });
    // One millisecond later it is a flow that started after the revoke: allowed.
    expect(await completeConnection(conn.connectionId, new Date(revokedAt.getTime() + 1))).toBe(true);
    expect(await state(conn.connectionId)).toEqual({ status: 'active', credentials: 0 });
  });

  test('an agent starting an authorization on an active account still records it', async () => {
    const conn = await seedConnection('revoke-sticky-agent-active', 'active');
    const moved = await connectConnection(conn.connectionId, { metadata: { session_id: 'sess_2' } });
    expect(moved?.connectionId).toBe(conn.connectionId);
    expect(await state(conn.connectionId)).toEqual({ status: 'active', credentials: 0 });
  });

  test('a person clicking connect revives a revoked account', async () => {
    const conn = await seedConnection('revoke-sticky-person-connect', 'revoked', minutesAgo(10));
    expect(await connectConnection(conn.connectionId, {}, undefined, 'person')).not.toBeNull();
    expect(await state(conn.connectionId)).toEqual({ status: 'active', credentials: 0 });
  });
});
