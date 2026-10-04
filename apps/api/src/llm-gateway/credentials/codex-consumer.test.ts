import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = 'session-1';
const SECRET_ID = '44444444-4444-4444-8444-444444444444';
const audits: Array<Record<string, unknown>> = [];
const updates: Array<{ table: unknown; value: Record<string, unknown> }> = [];
const wheres: unknown[] = [];
const LOADED_AT = new Date('2026-09-25T10:00:00.123Z');

let resolvedValue: string | null = JSON.stringify({
  openai: { type: 'oauth', access: 'codex-access', expires: Date.now() + 60 * 60_000 },
});
const resolveProjectSecretForConsumer = mock(async () =>
  resolvedValue === null
    ? null
    : {
        accountId: ACCOUNT_ID,
        secretId: SECRET_ID,
        ownerUserId: USER_ID,
        updatedAt: new Date('2026-08-05T12:00:00.000Z'),
        value: resolvedValue,
      },
);

mock.module('../../projects/secrets', () => ({
  encryptProjectSecret: (_projectId: string, value: string) => value,
  resolveProjectSecretForConsumer,
}));

mock.module('../../lib/db', () => ({
  db: {
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => {
        updates.push({ table, value });
        return {
          where: async (condition: unknown) => {
            wheres.push(condition);
            return [];
          },
        };
      },
    }),
  },
}));

mock.module('../../services/audit/audit', () => ({
  recordAuditEvent: async (event: Record<string, unknown>) => {
    audits.push(event);
  },
}));

const { accountSecretResources, projectSecrets } = await import('@kortix/db');
const { CodexRefreshError, resolveCodexCredential, resolveCodexAccountCredential, refreshRefusedCodexAccountLogin } = await import('./codex');

describe('resolveCodexCredential consumer boundary', () => {
  beforeEach(() => {
    resolveProjectSecretForConsumer.mockClear();
    audits.length = 0;
    updates.length = 0;
    wheres.length = 0;
    resolvedValue = JSON.stringify({
      openai: { type: 'oauth', access: 'codex-access', expires: Date.now() + 60 * 60_000 },
    });
  });

  test('loads the user override through the audited LLM gateway boundary', async () => {
    expect(
      await resolveCodexCredential(PROJECT_ID, USER_ID, undefined, {
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
      }),
    ).toEqual({ access: 'codex-access', accountId: undefined });
    expect(resolveProjectSecretForConsumer).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      actorUserId: USER_ID,
      principalUserId: USER_ID,
      name: 'CODEX_AUTH_JSON',
      consumer: 'llm_gateway',
    });
  });

  test('returns null when the delivery policy denies the credential', async () => {
    resolvedValue = null;

    expect(
      await resolveCodexCredential(PROJECT_ID, USER_ID, undefined, {
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
      }),
    ).toBeNull();
  });

  test('refreshes an expiring credential and records metadata-only success', async () => {
    resolvedValue = JSON.stringify({
      openai: { type: 'oauth', access: 'old-access', refresh: 'refresh-token', expires: 0 },
    });
    const fetchImpl = mock(async () =>
      Response.json({ access_token: 'new-access', expires_in: 3600 }),
    );

    expect(
      await resolveCodexCredential(PROJECT_ID, USER_ID, fetchImpl, {
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
      }),
    ).toEqual({ access: 'new-access', accountId: undefined });
    expect(updates.map((update) => update.table)).toEqual([projectSecrets]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'secret.consumer.refreshed',
        resourceId: SECRET_ID,
        metadata: {
          identifier: 'CODEX_AUTH_JSON',
          consumer: 'llm_gateway',
          value_source: 'personal',
          upstream_status: 200,
        },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain('new-access');
    expect(JSON.stringify(audits)).not.toContain('refresh-token');
  });

  test('refreshes a selected account OAuth resource in its own encrypted row', async () => {
    const authJson = JSON.stringify({ openai: {
      type: 'oauth', access: 'old-account-access', refresh: 'account-refresh', expires: 0,
    } });
    const fetchImpl = mock(async () => Response.json({ access_token: 'new-account-access', expires_in: 3600 }));
    expect(await resolveCodexAccountCredential({
      projectId: PROJECT_ID, accountId: ACCOUNT_ID, sessionId: SESSION_ID,
      userId: USER_ID, secretId: SECRET_ID, value: authJson, updatedAt: LOADED_AT,
    }, fetchImpl)).toEqual({ access: 'new-account-access', accountId: undefined });
    expect(updates.map((update) => update.table)).toEqual([accountSecretResources]);
    const ciphertext = String(updates[0]?.value.valueEnc);
    expect(ciphertext.startsWith('v1:')).toBe(true);
    expect(ciphertext).not.toContain('new-account-access');
    expect(ciphertext).not.toContain('account-refresh');
    // A login that refreshes again no longer needs reconnection.
    expect(updates[0]?.value).toHaveProperty('needsReauthAt', null);
    expect(audits[0]).toMatchObject({ resourceId: SECRET_ID, metadata: { value_source: 'account_resource' } });
    expect(JSON.stringify(audits)).not.toContain('account-refresh');
  });

  test('records a failed refresh without credential material', async () => {
    resolvedValue = JSON.stringify({
      openai: { type: 'oauth', access: 'old-access', refresh: 'refresh-token', expires: 0 },
    });
    const fetchImpl = mock(async () => new Response('{}', { status: 401 }));

    await expect(
      resolveCodexCredential(PROJECT_ID, USER_ID, fetchImpl, {
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(CodexRefreshError);
    expect(audits).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        action: 'secret.consumer.refresh_failed',
        metadata: {
          identifier: 'CODEX_AUTH_JSON',
          consumer: 'llm_gateway',
          value_source: 'personal',
          upstream_status: 401,
          permanent: true,
        },
      }),
    ]);
    // The project login has no account row to mark.
    expect(updates).toEqual([]);
    expect(JSON.stringify(audits)).not.toContain('old-access');
    expect(JSON.stringify(audits)).not.toContain('refresh-token');
  });
});

describe('resolveCodexAccountCredential marks a login that needs reconnection', () => {
  const expiring = JSON.stringify({ openai: {
    type: 'oauth', access: 'old-account-access', refresh: 'account-refresh', expires: 0,
  } });
  const account = (value: string | null) => ({
    projectId: PROJECT_ID, accountId: ACCOUNT_ID, sessionId: SESSION_ID,
    userId: USER_ID, secretId: SECRET_ID, value, updatedAt: LOADED_AT,
  });
  const marks = () => updates
    .map((update) => update.value)
    .filter((value) => 'needsReauthAt' in value && value.needsReauthAt !== null);

  beforeEach(() => {
    audits.length = 0;
    updates.length = 0;
    wheres.length = 0;
  });

  test('a refresh the provider rejects marks the account, guarded by the version it read', async () => {
    const fetchImpl = mock(async () => Response.json({ error: {
      message: 'Could not validate your refresh token. Please try signing in again.',
      type: 'invalid_request_error', param: null, code: 'invalid_refresh_token',
    } }, { status: 401 }));

    const failure = await resolveCodexAccountCredential(account(expiring), fetchImpl).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CodexRefreshError);
    expect(failure).toMatchObject({ status: 401, code: 'invalid_refresh_token', permanent: true });
    expect(marks()).toHaveLength(1);
    // The mark never moves updated_at: a concurrent refresh or reconnect still wins.
    expect(marks()[0]).not.toHaveProperty('updatedAt');
    const guard = new PgDialect().sqlToQuery(wheres[0] as never);
    expect(guard.sql).toContain(`date_trunc('milliseconds', "kortix"."account_secret_resources"."updated_at") = $3::timestamptz`);
    expect(guard.params).toEqual([ACCOUNT_ID, SECRET_ID, '2026-09-25T10:00:00.123Z']);
    expect(audits[0]).toMatchObject({
      action: 'secret.consumer.refresh_failed',
      metadata: { upstream_status: 401, permanent: true, error_code: 'invalid_refresh_token' },
    });
    expect(JSON.stringify(audits)).not.toContain('account-refresh');
  });

  test('a transient failure never marks the account', async () => {
    for (const fetchImpl of [
      mock(async () => new Response('upstream unavailable', { status: 503 })),
      mock(async () => Response.json({ error: 'invalid_grant' }, { status: 429 })),
      mock(async () => { throw new TypeError('fetch failed'); }),
    ]) {
      const failure = await resolveCodexAccountCredential(account(expiring), fetchImpl).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(CodexRefreshError);
      expect(failure).toMatchObject({ permanent: false });
    }
    expect(marks()).toEqual([]);
  });

  test('a stored login that cannot be read marks the account without calling the provider', async () => {
    const fetchImpl = mock(async () => Response.json({ access_token: 'never' }));
    for (const value of [null, '{}', JSON.stringify({ openai: { type: 'oauth' } })]) {
      expect(await resolveCodexAccountCredential(account(value), fetchImpl)).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(marks()).toHaveLength(3);
  });
});

// Seen on dev 2026-09-29: ChatGPT refused a stored login with 401 "Could not
// parse your authentication token" while its stored expiry was weeks away, so
// the gateway never refreshed it and every turn failed. The gateway now asks
// for a forced refresh when the provider refuses a login.
describe('refreshRefusedCodexAccountLogin', () => {
  const sha256 = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
  const login = (access: string, extra: Record<string, unknown> = {}) => ({
    value: JSON.stringify({ openai: { type: 'oauth', access, refresh: 'refresh-token', expires: Date.now() + 86_400_000, accountId: 'chatgpt-acct' } }),
    updatedAt: LOADED_AT,
    needsReauthAt: null as Date | null,
    ...extra,
  });
  const input = (refusedAccess: string) => ({
    projectId: PROJECT_ID, accountId: ACCOUNT_ID, sessionId: SESSION_ID, userId: USER_ID,
    secretId: SECRET_ID, failedKeySha256: sha256(refusedAccess),
  });
  const marks = () => updates.map((update) => update.value).filter((value) => 'needsReauthAt' in value && value.needsReauthAt !== null);

  beforeEach(() => {
    audits.length = 0;
    updates.length = 0;
    wheres.length = 0;
  });

  test('forces a refresh of an unexpired login and stores the new token', async () => {
    const fetchImpl = mock(async () => Response.json({ access_token: 'fresh-access', refresh_token: 'rotated', expires_in: 864000 }));
    const result = await refreshRefusedCodexAccountLogin(input('refused-access'), {
      load: async () => login('refused-access'), fetchImpl,
    });
    expect(result).toEqual({ access: 'fresh-access', accountId: 'chatgpt-acct' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.table)).toEqual([accountSecretResources]);
    expect(updates[0]?.value).toHaveProperty('needsReauthAt', null);
  });

  test('a login another request already refreshed is returned without a second refresh', async () => {
    const fetchImpl = mock(async () => Response.json({ access_token: 'never' }));
    const result = await refreshRefusedCodexAccountLogin(input('refused-access'), {
      load: async () => login('already-fresh'), fetchImpl,
    });
    expect(result).toEqual({ access: 'already-fresh', accountId: 'chatgpt-acct' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('a refresh the provider refuses marks the login for reconnection and yields no token', async () => {
    const fetchImpl = mock(async () => Response.json({ error: { code: 'invalid_refresh_token' } }, { status: 401 }));
    const result = await refreshRefusedCodexAccountLogin(input('refused-access'), {
      load: async () => login('refused-access'), fetchImpl,
    });
    expect(result).toBeNull();
    expect(marks()).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'secret.consumer.refresh_failed', metadata: { permanent: true } });
  });

  test('a refresh lost to another replica uses the winner\'s token', async () => {
    let reads = 0;
    const fetchImpl = mock(async () => Response.json({ error: { code: 'refresh_token_reused' } }, { status: 400 }));
    const result = await refreshRefusedCodexAccountLogin(input('refused-access'), {
      load: async () => (reads++ === 0 ? login('refused-access') : login('winner-access', { updatedAt: new Date() })),
      fetchImpl,
    });
    expect(result).toEqual({ access: 'winner-access', accountId: 'chatgpt-acct' });
  });

  test('a login already marked for reconnection, missing, or unreadable is not refreshed', async () => {
    const fetchImpl = mock(async () => Response.json({ access_token: 'never' }));
    expect(await refreshRefusedCodexAccountLogin(input('refused-access'), {
      load: async () => login('refused-access', { needsReauthAt: new Date() }), fetchImpl,
    })).toBeNull();
    expect(await refreshRefusedCodexAccountLogin(input('refused-access'), { load: async () => null, fetchImpl })).toBeNull();
    expect(await refreshRefusedCodexAccountLogin(input('refused-access'), {
      load: async () => ({ value: '{}', updatedAt: LOADED_AT, needsReauthAt: null }), fetchImpl,
    })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(marks()).toHaveLength(1);
  });

  test('a refused login with no refresh token is marked for reconnection', async () => {
    const fetchImpl = mock(async () => Response.json({ access_token: 'never' }));
    const value = JSON.stringify({ openai: { type: 'oauth', access: 'refused-access', expires: Date.now() + 86_400_000 } });
    expect(await refreshRefusedCodexAccountLogin(input('refused-access'), {
      load: async () => ({ value, updatedAt: LOADED_AT, needsReauthAt: null }), fetchImpl,
    })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(marks()).toHaveLength(1);
  });
});
