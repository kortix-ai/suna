import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

const {
  decryptWorkspaceSecret,
  encryptWorkspaceSecret,
  getWorkspaceSecretValueForConsumer,
  listWorkspaceSecretNamesForConsumer,
  resolveWorkspaceSecretsForConsumer,
} = await import('./secrets');

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'session-1';

function secret(overrides: Record<string, unknown> = {}) {
  return {
    secretId: '33333333-3333-4333-8333-333333333333',
    identifier: 'provider-primary',
    ownerUserId: null,
    valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'plaintext-test-value'),
    scope: 'runtime',
    active: true,
    strategy: 'broker',
    consumer: 'llm_gateway',
    updatedAt: new Date('2026-08-05T12:00:00.000Z'),
    ...overrides,
  };
}

function read(principalUserId?: string) {
  return getWorkspaceSecretValueForConsumer({
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    actorUserId: '44444444-4444-4444-8444-444444444444',
    name: 'provider_key',
    consumer: 'llm_gateway',
    principalUserId,
  });
}

describe('getWorkspaceSecretValueForConsumer', () => {
  beforeEach(() => {
    rows = [];
    audits.length = 0;
  });

  test('returns plaintext only to the configured consumer and records the use', async () => {
    rows = [secret()];

    expect(await read()).toBe('plaintext-test-value');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      actorType: 'agent',
      source: 'llm_gateway',
      action: 'secret.consumer.used',
      resourceType: 'project_secret',
      metadata: {
        identifier: 'provider-primary',
        name: 'PROVIDER_KEY',
        consumer: 'llm_gateway',
      },
    });
    expect(JSON.stringify(audits)).not.toContain('plaintext-test-value');
  });

  test('does not decrypt or audit fallback identifiers when the first value resolves', async () => {
    rows = [
      secret({ identifier: 'PROVIDER_KEY' }),
      secret({
        secretId: '55555555-5555-4555-8555-555555555555',
        identifier: 'provider-secondary',
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'secondary-value'),
      }),
    ];

    expect(await read()).toBe('plaintext-test-value');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ metadata: { identifier: 'PROVIDER_KEY' } });
  });

  test('denies a runtime sandbox secret to the LLM gateway', async () => {
    rows = [secret({ strategy: 'runtime', consumer: 'sandbox' })];

    expect(await read()).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: 'denied',
      action: 'secret.consumer.denied',
      metadata: {
        requested_consumer: 'llm_gateway',
        configured_consumer: 'sandbox',
      },
    });
    expect(JSON.stringify(audits)).not.toContain('plaintext-test-value');
  });

  test('allows a connector-scoped legacy row only through the connector boundary', async () => {
    rows = [secret({ scope: 'connector', strategy: 'runtime', consumer: 'connector' })];

    expect(
      await getWorkspaceSecretValueForConsumer({
        workspaceId: WORKSPACE_ID,
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        actorUserId: '44444444-4444-4444-8444-444444444444',
        name: 'provider_key',
        consumer: 'connector',
      }),
    ).toBe('plaintext-test-value');
    expect(audits[0]).toMatchObject({
      source: 'connector',
      action: 'secret.consumer.used',
      metadata: { consumer: 'connector' },
    });
    expect(JSON.stringify(audits)).not.toContain('plaintext-test-value');
  });

  test('allows a broker row assigned to the connector consumer', async () => {
    rows = [secret({ strategy: 'broker', consumer: 'connector' })];

    expect(
      await getWorkspaceSecretValueForConsumer({
        workspaceId: WORKSPACE_ID,
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        actorUserId: '44444444-4444-4444-8444-444444444444',
        name: 'provider_key',
        consumer: 'connector',
      }),
    ).toBe('plaintext-test-value');
    expect(audits[0]).toMatchObject({ action: 'secret.consumer.used' });
  });

  test('uses an active personal value under the shared delivery policy', async () => {
    rows = [
      secret(),
      secret({
        secretId: '55555555-5555-4555-8555-555555555555',
        ownerUserId: '44444444-4444-4444-8444-444444444444',
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'personal-value'),
      }),
    ];

    expect(await read('44444444-4444-4444-8444-444444444444')).toBe('personal-value');
    expect(audits[0]).toMatchObject({
      resourceId: '55555555-5555-4555-8555-555555555555',
      metadata: {
        identifier: 'provider-primary',
        consumer: 'llm_gateway',
        value_source: 'personal',
      },
    });
  });

  test('uses the shared value when the personal override is inactive', async () => {
    rows = [
      secret(),
      secret({
        secretId: '55555555-5555-4555-8555-555555555555',
        ownerUserId: '44444444-4444-4444-8444-444444444444',
        active: false,
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'inactive-personal-value'),
      }),
    ];

    expect(await read('44444444-4444-4444-8444-444444444444')).toBe(
      'plaintext-test-value',
    );
    expect(audits[0]).toMatchObject({
      resourceId: '33333333-3333-4333-8333-333333333333',
      metadata: { value_source: 'shared' },
    });
    expect(JSON.stringify(audits)).not.toContain('inactive-personal-value');
  });

  test('records a denied lookup when the secret is absent', async () => {
    expect(await read()).toBeNull();
    expect(audits).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        action: 'secret.consumer.missing',
        metadata: { name: 'PROVIDER_KEY', consumer: 'llm_gateway' },
      }),
    ]);
  });

  test('denies an inactive secret to its configured consumer', async () => {
    rows = [secret({ active: false })];

    expect(await read()).toBeNull();
    expect(audits[0]).toMatchObject({
      outcome: 'denied',
      action: 'secret.consumer.denied',
    });
  });

  test('returns null and records malformed ciphertext without exposing it', async () => {
    rows = [secret({ valueEnc: 'not-an-envelope' })];

    expect(await read()).toBeNull();
    expect(audits).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        action: 'secret.consumer.invalid',
        metadata: {
          identifier: 'provider-primary',
          name: 'PROVIDER_KEY',
          consumer: 'llm_gateway',
          value_source: 'shared',
        },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain('not-an-envelope');
  });
});

describe('resolveWorkspaceSecretsForConsumer', () => {
  beforeEach(() => {
    rows = [];
    audits.length = 0;
  });

  test('returns every authorized identifier in deterministic fallback order', async () => {
    rows = [
      secret({
        secretId: '55555555-5555-4555-8555-555555555555',
        identifier: 'provider-secondary',
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'secondary-value'),
        updatedAt: new Date('2026-08-05T14:00:00.000Z'),
      }),
      secret({
        identifier: 'PROVIDER_KEY',
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'canonical-value'),
        updatedAt: new Date('2026-08-05T10:00:00.000Z'),
      }),
      secret({
        secretId: '66666666-6666-4666-8666-666666666666',
        identifier: 'provider-tertiary',
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'tertiary-value'),
        updatedAt: new Date('2026-08-05T13:00:00.000Z'),
      }),
    ];

    const values = await resolveWorkspaceSecretsForConsumer({
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      actorUserId: '44444444-4444-4444-8444-444444444444',
      name: 'provider_key',
      consumer: 'llm_gateway',
    });

    expect(values.map(({ identifier, value }) => ({ identifier, value }))).toEqual([
      { identifier: 'PROVIDER_KEY', value: 'canonical-value' },
      { identifier: 'provider-secondary', value: 'secondary-value' },
      { identifier: 'provider-tertiary', value: 'tertiary-value' },
    ]);
    expect(audits.map((event) => event.action)).toEqual([
      'secret.consumer.used',
      'secret.consumer.used',
      'secret.consumer.used',
    ]);
    expect(JSON.stringify(audits)).not.toContain('canonical-value');
    expect(JSON.stringify(audits)).not.toContain('secondary-value');
    expect(JSON.stringify(audits)).not.toContain('tertiary-value');
  });

  test('applies a personal override to its matching identifier only', async () => {
    rows = [
      secret({ identifier: 'provider-primary' }),
      secret({
        secretId: '55555555-5555-4555-8555-555555555555',
        identifier: 'provider-primary',
        ownerUserId: '44444444-4444-4444-8444-444444444444',
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'personal-primary'),
      }),
      secret({
        secretId: '66666666-6666-4666-8666-666666666666',
        identifier: 'provider-secondary',
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'shared-secondary'),
      }),
    ];

    const values = await resolveWorkspaceSecretsForConsumer({
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      actorUserId: '44444444-4444-4444-8444-444444444444',
      principalUserId: '44444444-4444-4444-8444-444444444444',
      name: 'provider_key',
      consumer: 'llm_gateway',
    });

    expect(values.map(({ identifier, value }) => ({ identifier, value }))).toEqual([
      { identifier: 'provider-primary', value: 'personal-primary' },
      { identifier: 'provider-secondary', value: 'shared-secondary' },
    ]);
    expect(audits[0]).toMatchObject({ metadata: { value_source: 'personal' } });
    expect(audits[1]).toMatchObject({ metadata: { value_source: 'shared' } });
  });

  test('skips denied and malformed identifiers while returning valid fallbacks', async () => {
    rows = [
      secret({
        identifier: 'denied',
        strategy: 'runtime',
        consumer: 'sandbox',
      }),
      secret({ identifier: 'invalid', valueEnc: 'invalid-envelope' }),
      secret({
        secretId: '66666666-6666-4666-8666-666666666666',
        identifier: 'valid',
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'valid-value'),
      }),
    ];

    const values = await resolveWorkspaceSecretsForConsumer({
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      name: 'provider_key',
      consumer: 'llm_gateway',
    });

    expect(values.map(({ identifier, value }) => ({ identifier, value }))).toEqual([
      { identifier: 'valid', value: 'valid-value' },
    ]);
    expect(audits.map((event) => event.action)).toEqual([
      'secret.consumer.denied',
      'secret.consumer.invalid',
      'secret.consumer.used',
    ]);
  });
});

test('project secret encryption preserves an empty value', () => {
  const envelope = encryptWorkspaceSecret(WORKSPACE_ID, '');

  expect(decryptWorkspaceSecret(WORKSPACE_ID, envelope)).toBe('');
});

describe('listWorkspaceSecretNamesForConsumer', () => {
  beforeEach(() => {
    rows = [];
  });

  test('lists only active secrets assigned to the requested server consumer', async () => {
    rows = [
      secret({ identifier: 'openai', name: 'OPENAI_API_KEY' }),
      secret({
        identifier: 'runtime',
        name: 'RUNTIME_KEY',
        strategy: 'runtime',
        consumer: 'sandbox',
      }),
      secret({
        identifier: 'denied',
        name: 'DENIED_KEY',
        strategy: 'denied',
        consumer: null,
      }),
      secret({
        identifier: 'broker',
        name: 'BROKER_KEY',
        strategy: 'broker',
        consumer: 'http_broker',
      }),
    ];

    expect(
      await listWorkspaceSecretNamesForConsumer({
        workspaceId: WORKSPACE_ID,
        consumer: 'llm_gateway',
      }),
    ).toEqual(['OPENAI_API_KEY']);
  });

  test('includes an active personal provider credential for that user', async () => {
    rows = [
      secret({
        name: 'CODEX_AUTH_JSON',
        ownerUserId: '44444444-4444-4444-8444-444444444444',
      }),
    ];

    expect(
      await listWorkspaceSecretNamesForConsumer({
        workspaceId: WORKSPACE_ID,
        principalUserId: '44444444-4444-4444-8444-444444444444',
        consumer: 'llm_gateway',
      }),
    ).toEqual(['CODEX_AUTH_JSON']);
  });
});
