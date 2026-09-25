import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = 'session-1';
const SECRET_ID = '44444444-4444-4444-8444-444444444444';
const audits: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
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
  decryptProjectSecret: (_projectId: string, value: string) => value,
  encryptProjectSecret: (_projectId: string, value: string) => value,
  resolveProjectSecretForConsumer,
}));

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [
          {
            secretId: SECRET_ID,
            ownerUserId: USER_ID,
            valueEnc: resolvedValue,
          },
        ],
      }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => {
        updates.push(value);
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

mock.module('../../shared/audit', () => ({
  recordAuditEvent: async (event: Record<string, unknown>) => {
    audits.push(event);
  },
}));

const { CodexRefreshError, resolveCodexCredential, resolveCodexAccountCredential } = await import('./codex');

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
    expect(updates).toHaveLength(1);
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
    expect(updates).toHaveLength(1);
    expect(String(updates[0]?.valueEnc).startsWith('v1:')).toBe(true);
    // A login that refreshes again no longer needs reconnection.
    expect(updates[0]).toHaveProperty('needsReauthAt', null);
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
  const marks = () => updates.filter((update) => 'needsReauthAt' in update && update.needsReauthAt !== null);

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
