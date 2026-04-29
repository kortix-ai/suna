import { describe, test, expect, mock } from 'bun:test';

mock.module('../config', () => ({
  config: {
    API_KEY_SECRET: 'test-secret-key-for-unit-tests-32ch',
    ENV_MODE: 'local',
    INTERNAL_KORTIX_ENV: 'staging',
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    KORTIX_URL: 'http://localhost:3000',
  },
}));

// Capture what gets written to DB
let writtenPayload: Record<string, string> | null = null;
let storedRow: { id: string; credentials: Record<string, string> } | null = null;

mock.module('@kortix/db', () => ({
  integrationCredentials: {
    accountId: { name: 'accountId' },
    provider: { name: 'provider' },
    isActive: { name: 'isActive' },
    id: { name: 'id' },
    $inferInsert: {} as any,
  },
}));

mock.module('../shared/db', () => {
  const eq = (col: any, val: any) => ({ col, val });
  const and = (...args: any[]) => ({ args });

  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              then: (resolve: any) => resolve(storedRow ? [storedRow] : []),
            }),
          }),
        }),
      }),
      insert: () => ({
        values: (v: any) => ({
          then: (resolve: any) => {
            writtenPayload = v.credentials;
            storedRow = { id: 'cred-1', credentials: v.credentials };
            return resolve(undefined);
          },
        }),
      }),
      update: () => ({
        set: (v: any) => ({
          where: () => ({
            then: (resolve: any) => {
              if (v.credentials) {
                writtenPayload = v.credentials;
                if (storedRow) storedRow.credentials = v.credentials;
              }
              return resolve(undefined);
            },
          }),
        }),
      }),
    },
    eq,
    and,
  };
});

describe('credential-store encryption', () => {
  test('upsertAccountCreds stores encrypted client_secret (not plaintext)', async () => {
    const cb = `?t=${Date.now()}`;
    const { upsertAccountCreds } = await import(`../integrations/credential-store.ts${cb}`);

    await upsertAccountCreds('acc-1', {
      client_id: 'cid_123',
      client_secret: 'super-secret-value',
      project_id: 'proj_abc',
    });

    // The stored value must NOT be the plaintext
    expect(writtenPayload).not.toBeNull();
    expect(writtenPayload!.client_secret).not.toBe('super-secret-value');
    // Must be encrypted (starts with enc:v1:)
    expect(writtenPayload!.client_secret.startsWith('enc:v1:')).toBe(true);
    // Non-sensitive fields unchanged
    expect(writtenPayload!.client_id).toBe('cid_123');
    expect(writtenPayload!.project_id).toBe('proj_abc');
  });

  test('getAccountCreds decrypts and returns original plaintext', async () => {
    const cb = `?t=${Date.now() + 1}`;
    const { upsertAccountCreds, getAccountCreds } = await import(`../integrations/credential-store.ts${cb}`);

    // Reset state
    writtenPayload = null;
    storedRow = null;

    await upsertAccountCreds('acc-2', {
      client_id: 'cid_456',
      client_secret: 'my-oauth-secret',
      project_id: 'proj_xyz',
    });

    // storedRow now has encrypted credentials
    const result = await getAccountCreds('acc-2');

    expect(result).not.toBeNull();
    expect(result!.client_secret).toBe('my-oauth-secret');  // decrypted correctly
    expect(result!.client_id).toBe('cid_456');
  });

  test('legacy plaintext rows are decrypted transparently (passthrough)', async () => {
    const cb = `?t=${Date.now() + 2}`;
    const { getAccountCreds } = await import(`../integrations/credential-store.ts${cb}`);

    // Simulate a legacy plaintext row
    storedRow = {
      id: 'cred-legacy',
      credentials: {
        client_id: 'cid_legacy',
        client_secret: 'plaintext-secret',  // NOT encrypted
        project_id: 'proj_legacy',
        environment: 'production',
      },
    };

    const result = await getAccountCreds('acc-legacy');
    expect(result).not.toBeNull();
    // Passthrough: plaintext returned as-is
    expect(result!.client_secret).toBe('plaintext-secret');
  });
});
