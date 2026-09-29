import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Characterization tests (KRTX-322): pin the EXACT audit event shape of every
// consumer decision site in projects/secrets.ts before `recordSecretConsumerAudit`
// is extracted. These pass unchanged before and after the refactor; any drift
// in action, outcome, resourceId presence or metadata keys fails here.

let rows: Array<Record<string, unknown>> = [];
const audits: Array<Record<string, unknown>> = [];

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  },
}));

mock.module('../shared/audit', () => ({
  recordAuditEvent: async (event: Record<string, unknown>) => {
    audits.push(event);
  },
}));

const { encryptProjectSecret, getProjectSecretValueForConsumer } = await import('./secrets');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'session-1';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const SECRET_ID = '33333333-3333-4333-8333-333333333333';

function secret(overrides: Record<string, unknown> = {}) {
  return {
    secretId: SECRET_ID,
    identifier: 'provider-primary',
    ownerUserId: null,
    valueEnc: 'not-an-envelope-yet',
    scope: 'runtime',
    active: true,
    strategy: 'broker',
    consumer: 'llm_gateway',
    updatedAt: new Date('2026-08-05T12:00:00.000Z'),
    ...overrides,
  };
}

function read(input: Record<string, unknown> = {}) {
  return getProjectSecretValueForConsumer({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    actorUserId: ACTOR_ID,
    name: 'provider_key',
    consumer: 'llm_gateway',
    ...input,
  });
}

/** The consumer read with an encryptable row: value resolves and is audited. */
function usableSecret() {
  return secret({ valueEnc: encryptProjectSecret(PROJECT_ID, 'plaintext-test-value') });
}

/** Comma-joined sorted key set: pins key presence exactly, including
 * keys that must be ABSENT (bun's toEqual ignores undefined properties). */
function keySet(event: Record<string, unknown>): string {
  return Object.keys(event).sort().join(',');
}

describe('consumer audit event shapes (characterization)', () => {
  beforeEach(() => {
    rows = [];
    audits.length = 0;
  });

  test('a used decision records the full used event and no outcome key', async () => {
    rows = [usableSecret()];

    expect(await read()).toBe('plaintext-test-value');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      actorUserId: ACTOR_ID,
      actorType: 'agent',
      source: 'llm_gateway',
      action: 'secret.consumer.used',
      resourceType: 'project_secret',
      resourceId: SECRET_ID,
      metadata: {
        identifier: 'provider-primary',
        name: 'PROVIDER_KEY',
        consumer: 'llm_gateway',
        value_source: 'shared',
      },
    });
    expect(
      keySet(audits[0]),
    ).toBe(
      'accountId,action,actorType,actorUserId,metadata,projectId,resourceId,resourceType,sessionId,source',
    );
    expect(JSON.stringify(audits)).not.toContain('plaintext-test-value');
  });

  test('a denied decision records the full denied event', async () => {
    rows = [secret({ strategy: 'runtime', consumer: 'sandbox' })];

    expect(await read()).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      actorUserId: ACTOR_ID,
      actorType: 'agent',
      source: 'llm_gateway',
      outcome: 'denied',
      action: 'secret.consumer.denied',
      resourceType: 'project_secret',
      resourceId: SECRET_ID,
      metadata: {
        identifier: 'provider-primary',
        name: 'PROVIDER_KEY',
        requested_consumer: 'llm_gateway',
        configured_consumer: 'sandbox',
        strategy: 'runtime',
        value_source: 'shared',
      },
    });
    expect(
      keySet(audits[0]),
    ).toBe(
      'accountId,action,actorType,actorUserId,metadata,outcome,projectId,resourceId,resourceType,sessionId,source',
    );
  });

  test('a failure decision records the full invalid event', async () => {
    rows = [secret({ valueEnc: 'not-an-envelope' })];

    expect(await read()).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      actorUserId: ACTOR_ID,
      actorType: 'agent',
      source: 'llm_gateway',
      outcome: 'failure',
      action: 'secret.consumer.invalid',
      resourceType: 'project_secret',
      resourceId: SECRET_ID,
      metadata: {
        identifier: 'provider-primary',
        name: 'PROVIDER_KEY',
        consumer: 'llm_gateway',
        value_source: 'shared',
      },
    });
    expect(
      keySet(audits[0]),
    ).toBe(
      'accountId,action,actorType,actorUserId,metadata,outcome,projectId,resourceId,resourceType,sessionId,source',
    );
    expect(JSON.stringify(audits)).not.toContain('not-an-envelope');
  });

  test('a missing lookup records the missing event without a resourceId key', async () => {
    rows = [];

    expect(await read()).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      actorUserId: ACTOR_ID,
      actorType: 'agent',
      source: 'llm_gateway',
      outcome: 'denied',
      action: 'secret.consumer.missing',
      resourceType: 'project_secret',
      metadata: { name: 'PROVIDER_KEY', consumer: 'llm_gateway' },
    });
    expect(
      keySet(audits[0]),
    ).toBe(
      'accountId,action,actorType,actorUserId,metadata,outcome,projectId,resourceType,sessionId,source',
    );
  });

  test('actorType derives from the acting context: agent, human, system', async () => {
    // agent: a session is in play
    rows = [usableSecret()];
    await read();
    expect(audits[0]).toMatchObject({ actorType: 'agent' });

    // human: an acting user, no session
    audits.length = 0;
    rows = [usableSecret()];
    await read({ sessionId: undefined });
    expect(audits[0]).toMatchObject({ actorType: 'human' });

    // system: no session, no acting user
    audits.length = 0;
    rows = [usableSecret()];
    await read({ sessionId: undefined, actorUserId: undefined });
    expect(audits[0]).toMatchObject({ actorType: 'system' });
  });
});
