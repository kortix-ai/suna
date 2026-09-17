import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = 'session-1';
const SECRET_ID = '44444444-4444-4444-8444-444444444444';
const audits: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];

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
        return { where: async () => [] };
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
      userId: USER_ID, secretId: SECRET_ID, value: authJson,
    }, fetchImpl)).toEqual({ access: 'new-account-access', accountId: undefined });
    expect(updates).toHaveLength(1);
    expect(String(updates[0]?.valueEnc).startsWith('v1:')).toBe(true);
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
        },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain('old-access');
    expect(JSON.stringify(audits)).not.toContain('refresh-token');
  });
});
