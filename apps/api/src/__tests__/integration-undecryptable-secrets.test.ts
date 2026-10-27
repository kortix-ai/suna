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
 * - A broken active personal override is reported on `mine.status` and fails
 *   session start, even when the shared value is fine.
 * - An OAuth2 connection whose application or token cannot be decrypted names
 *   the application, reports its status, and still revokes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import { connectionCredentials, connectorConnections, connectors, projectSecrets, projectSessions, projects } from '@kortix/db';
import { config } from '../config';
import {
  ensureDefaultConnection,
  resolveConnectionCredentialValue,
  resolveCredentialValue,
  upsertConnectionCredential,
  upsertCredential,
} from '../connectors/credentials';
import {
  loadOAuth2Application,
  oauth2ConnectionStatus,
  revokeConnectionOAuth2,
  saveOAuth2Application,
} from '../connectors/oauth2-store';
import { loadSecretViewsForUser } from '../projects/lib/serializers';
import { buildSessionSandboxEnvVars } from '../projects/lib/sessions';
import { encryptProjectSecret, listResolvedProjectSecrets, writeSharedProjectSecret } from '../projects/secrets';
import { SecretUndecryptableError } from '../secrets/undecryptable';
import { db } from '../shared/db';
import { seedAccount } from './helpers/integration-fixtures';

const SUFFIX = crypto.randomUUID().slice(0, 8).toUpperCase();
const GOOD = `E2E_GOOD_${SUFFIX}`;
const BROKEN = `E2E_BROKEN_${SUFFIX}`;
const CONNECTOR_SLUG = `undecryptable-${SUFFIX.toLowerCase()}`;
const OVERRIDE = `E2E_OVERRIDE_${SUFFIX}`;
const OAUTH_SLUG = `undecryptable-oauth-${SUFFIX.toLowerCase()}`;
const SESSION_ID = `e2e-undecryptable-${crypto.randomUUID()}`;
const USER = crypto.randomUUID();
const ORIGINAL_KEY = config.API_KEY_SECRET;

let projectId: string;
let accountId: string;
let connectorId: string;
let oauthConnectorId: string | null = null;

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
  const connectorIds = [connectorId, ...(oauthConnectorId ? [oauthConnectorId] : [])];
  await db.delete(connectionCredentials).where(inArray(connectionCredentials.connectorId, connectorIds));
  await db.delete(connectorConnections).where(inArray(connectorConnections.connectorId, connectorIds));
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

describe('a broken personal override (KRTX-1719)', () => {
  // The session's personal-override owner is its on-behalf-of member in a
  // private session (personal-resources.ts); this fixture's user is no member,
  // so the read every session start runs is called with the user directly.
  const resolvedAsUser = () =>
    listResolvedProjectSecrets(projectId, USER).then(
      (rows) => rows,
      (thrown: unknown) => thrown,
    );

  test('shows on mine.status and fails the session-start read, though the shared value decrypts', async () => {
    await writeSharedProjectSecret({ projectId, name: OVERRIDE, value: 'shared-synthetic-value' });
    const brokenEnvelope = await underOtherKey(() => encryptProjectSecret(projectId, 'lost-override-value'));
    await db.insert(projectSecrets).values({
      projectId,
      identifier: OVERRIDE,
      name: OVERRIDE,
      valueEnc: brokenEnvelope,
      ownerUserId: USER,
      active: true,
      createdBy: USER,
    });

    const views = await loadSecretViewsForUser({ projectId, userId: USER, canManageShared: true });
    const view = views.find((item) => item.identifier === OVERRIDE);
    expect(view).toMatchObject({ configured: true, status: 'ok', effective_source: 'mine' });
    expect(view?.mine?.status).toBe('undecryptable');

    const error = await resolvedAsUser();
    expect(error).toBeInstanceOf(SecretUndecryptableError);
    expect((error as Error).message).toBe(
      `Your own value of project secret ${OVERRIDE} cannot be decrypted with this server's encryption key. Re-enter its value.`,
    );
  });

  test('removing the override lets the session read the shared value', async () => {
    await db
      .delete(projectSecrets)
      .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.identifier, OVERRIDE), eq(projectSecrets.ownerUserId, USER)));
    const views = await loadSecretViewsForUser({ projectId, userId: USER, canManageShared: true });
    expect(views.find((item) => item.identifier === OVERRIDE)).toMatchObject({ status: 'ok', mine: null, effective_source: 'shared' });
    const rows = await resolvedAsUser();
    expect(Array.isArray(rows) && rows.find((row) => row.identifier === OVERRIDE)?.value).toBe('shared-synthetic-value');
  });
});

describe('an OAuth2 connection this server cannot decrypt (KRTX-1719)', () => {
  const application = {
    client_id: 'synthetic-client',
    token_endpoint_auth_method: 'none',
    authorization_url: 'https://auth.example.test/authorize',
    token_url: 'https://auth.example.test/token',
    revocation_url: 'https://auth.example.test/revoke',
  } as OAuth2ApplicationInput;
  let identity: { accountId: string; projectId: string; connectorId: string; connectionId: string };

  beforeAll(async () => {
    const [connector] = await db
      .insert(connectors)
      .values({
        accountId,
        projectId,
        slug: OAUTH_SLUG,
        name: 'Undecryptable OAuth2 fixture',
        providerType: 'http',
        config: { baseUrl: 'https://connector.example.test', auth: { type: 'oauth2' } },
      })
      .returning({ connectorId: connectors.connectorId });
    oauthConnectorId = connector!.connectorId;
    const connectionId = await ensureDefaultConnection({ projectId, connectorId: oauthConnectorId, createdBy: USER });
    identity = { accountId, projectId, connectorId: oauthConnectorId, connectionId };
    await underOtherKey(async () => {
      await saveOAuth2Application(identity, application, USER);
      await upsertConnectionCredential({
        projectId,
        connectorId: oauthConnectorId!,
        connectionId,
        value: 'lost-delegated-token',
        kind: 'oauth2_delegated',
        createdBy: USER,
      });
    });
  });

  test('loading the application throws SecretUndecryptableError naming it and the remedy', async () => {
    const error = await loadOAuth2Application(identity.connectionId).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SecretUndecryptableError);
    expect((error as Error).message).toBe(
      `The OAuth application of connector ${OAUTH_SLUG} cannot be decrypted with this server's encryption key. Save the OAuth application again, then reconnect the account.`,
    );
  });

  test('a call through the delegated credential says to save the application before reconnecting', async () => {
    const error = await resolveConnectionCredentialValue({ connectorId: identity.connectorId, connectionId: identity.connectionId }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SecretUndecryptableError);
    expect((error as Error).message).toBe(
      `The credential of connector ${OAUTH_SLUG} cannot be decrypted with this server's encryption key. Save its OAuth application again, then reconnect the account.`,
    );
  });

  test('the status read reports credential_undecryptable instead of failing', async () => {
    expect(await oauth2ConnectionStatus(identity.connectionId)).toEqual({
      status: 'error',
      error_code: 'credential_undecryptable',
    });
  });

  test('revoke still deletes the local credential and marks the connection revoked', async () => {
    await revokeConnectionOAuth2(identity.connectionId);
    const credentials = await db
      .select({ id: connectionCredentials.credentialId })
      .from(connectionCredentials)
      .where(eq(connectionCredentials.connectionId, identity.connectionId));
    expect(credentials).toHaveLength(0);
    const [connection] = await db
      .select({ status: connectorConnections.status })
      .from(connectorConnections)
      .where(eq(connectorConnections.connectionId, identity.connectionId));
    expect(connection?.status).toBe('revoked');
  });

  test('saving the application again makes it readable', async () => {
    await saveOAuth2Application(identity, application, USER);
    expect((await loadOAuth2Application(identity.connectionId))?.application.client_id).toBe('synthetic-client');
  });
});
