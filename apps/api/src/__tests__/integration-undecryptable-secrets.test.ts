/**
 * Integration (real PostgreSQL): a stored value this server cannot decrypt is
 * reported as undecryptable, never as a missing value (KRTX-1719).
 *
 * The broken rows are real envelopes written under a different
 * `API_KEY_SECRET` — exactly what `env set API_KEY_SECRET=<new>` leaves behind.
 *
 * - The secrets list loader reports `status` per row and no plaintext.
 * - Session start fails with an error that names the secret.
 * - A connector credential read throws `SecretUndecryptableError` naming the
 *   connector, where it used to return null ("not connected").
 * - Entering the value again clears every one of these.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { connectionCredentials, connectorConnections, connectors, projectSecrets, projectSessions, projects } from '@kortix/db';
import { config } from '../config';
import { resolveConnectionCredentialValue, resolveCredentialValue, upsertCredential } from '../connectors/credentials';
import { loadSecretViewsForUser } from '../projects/lib/serializers';
import { buildSessionSandboxEnvVars } from '../projects/lib/sessions';
import { encryptProjectSecret, writeSharedProjectSecret } from '../projects/secrets';
import { SecretUndecryptableError } from '../secrets/undecryptable';
import { db } from '../shared/db';
import { seedAccount } from './helpers/integration-fixtures';

const SUFFIX = crypto.randomUUID().slice(0, 8).toUpperCase();
const GOOD = `E2E_GOOD_${SUFFIX}`;
const BROKEN = `E2E_BROKEN_${SUFFIX}`;
const CONNECTOR_SLUG = `undecryptable-${SUFFIX.toLowerCase()}`;
const SESSION_ID = `e2e-undecryptable-${crypto.randomUUID()}`;
const USER = crypto.randomUUID();
const ORIGINAL_KEY = config.API_KEY_SECRET;

let projectId: string;
let accountId: string;
let connectorId: string;

/** Run `write` as a server whose API_KEY_SECRET was different. */
async function underOtherKey<T>(write: () => Promise<T> | T): Promise<T> {
  config.API_KEY_SECRET = `${ORIGINAL_KEY}-before-rotation`;
  try {
    return await write();
  } finally {
    config.API_KEY_SECRET = ORIGINAL_KEY;
  }
}

async function sessionStartError(): Promise<unknown> {
  try {
    await buildSessionSandboxEnvVars({
      accountId,
      projectId,
      sessionId: SESSION_ID,
      userId: USER,
      repoUrl: 'https://example.test/undecryptable.git',
      baseRef: 'main',
      agentName: 'default',
      llmGatewayEnabled: false,
    });
    return null;
  } catch (error) {
    return error;
  }
}

beforeAll(async () => {
  accountId = await seedAccount('undecryptable-secrets');
  projectId = crypto.randomUUID();
  await db.insert(projects).values({
    projectId,
    accountId,
    name: `Undecryptable secrets ${SUFFIX}`,
    repoUrl: resolve(import.meta.dir, '../../../..'),
    // No manifest: the agent grant is 'all' without a Git checkout.
    defaultBranch: '',
    manifestPath: '',
  });
  await db.insert(projectSessions).values({
    sessionId: SESSION_ID,
    accountId,
    projectId,
    branchName: `undecryptable-${SUFFIX}`,
    createdBy: USER,
    agentName: 'default',
  });
  await writeSharedProjectSecret({ projectId, name: GOOD, value: 'good-synthetic-value' });
  const brokenEnvelope = await underOtherKey(() => encryptProjectSecret(projectId, 'lost-synthetic-value'));
  await writeSharedProjectSecret({ projectId, name: BROKEN, value: 'placeholder' });
  await db
    .update(projectSecrets)
    .set({ valueEnc: brokenEnvelope })
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.identifier, BROKEN), isNull(projectSecrets.ownerUserId)));

  const [connector] = await db
    .insert(connectors)
    .values({
      accountId,
      projectId,
      slug: CONNECTOR_SLUG,
      name: 'Undecryptable connector fixture',
      providerType: 'http',
      config: { baseUrl: 'https://connector.example.test', auth: { type: 'bearer' } },
    })
    .returning({ connectorId: connectors.connectorId });
  connectorId = connector!.connectorId;
  await underOtherKey(() => upsertCredential({ projectId, connectorId, userId: null, value: 'lost-connector-token' }));
});

afterAll(async () => {
  config.API_KEY_SECRET = ORIGINAL_KEY;
  await db.delete(connectionCredentials).where(eq(connectionCredentials.connectorId, connectorId));
  await db.delete(connectorConnections).where(eq(connectorConnections.connectorId, connectorId));
  await db.delete(connectors).where(eq(connectors.projectId, projectId));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION_ID));
  await db.delete(projectSecrets).where(eq(projectSecrets.projectId, projectId));
  await db.delete(projects).where(eq(projects.projectId, projectId));
});

describe('undecryptable stored values (KRTX-1719)', () => {
  test('the secrets list loader reports status per row and carries no value', async () => {
    const views = await loadSecretViewsForUser({ projectId, userId: null, canManageShared: true });
    const byIdentifier = new Map(views.map((view) => [view.identifier, view]));
    expect(byIdentifier.get(GOOD)?.status).toBe('ok');
    expect(byIdentifier.get(BROKEN)?.status).toBe('undecryptable');
    expect(byIdentifier.get(BROKEN)?.configured).toBe(true);
    const text = JSON.stringify(views);
    for (const plaintext of ['good-synthetic-value', 'lost-synthetic-value']) expect(text).not.toContain(plaintext);
  });

  test('session start fails with an error that names the undecryptable secret', async () => {
    const error = await sessionStartError();
    expect(error).toBeInstanceOf(SecretUndecryptableError);
    expect((error as Error).message).toBe(
      `Project secret ${BROKEN} cannot be decrypted with this server's encryption key. Re-enter its value.`,
    );
  });

  test('a connector credential read throws SecretUndecryptableError naming the connector, not null', async () => {
    const [credential] = await db
      .select({ connectionId: connectionCredentials.connectionId })
      .from(connectionCredentials)
      .where(eq(connectionCredentials.connectorId, connectorId));
    for (const read of [
      () => resolveCredentialValue(connectorId, null),
      () => resolveConnectionCredentialValue({ connectorId, connectionId: credential!.connectionId! }),
    ]) {
      const error = await read().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(SecretUndecryptableError);
      expect((error as Error).message).toContain(`The credential of connector ${CONNECTOR_SLUG} cannot be decrypted`);
      expect((error as Error).message).not.toContain('lost-connector-token');
    }
  });

  test('entering the values again clears every undecryptable state', async () => {
    await writeSharedProjectSecret({ projectId, name: BROKEN, value: 'reentered-synthetic-value' });
    await upsertCredential({ projectId, connectorId, userId: null, value: 'reentered-connector-token' });

    const views = await loadSecretViewsForUser({ projectId, userId: null, canManageShared: true });
    expect(views.find((view) => view.identifier === BROKEN)?.status).toBe('ok');
    expect(await sessionStartError()).toBeNull();
    expect(await resolveCredentialValue(connectorId, null)).toBe('reentered-connector-token');
  });
});
