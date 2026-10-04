import { describe, expect, mock, test } from 'bun:test';

// The refresh path persists the rotated login and audits it; record both.
const writes: Array<Record<string, unknown>> = [];
const audits: Array<Record<string, unknown>> = [];
mock.module('../../lib/db', () => ({
  db: { update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { writes.push(values); } }) }) },
}));
mock.module('../../services/audit/audit', () => ({ recordAuditEvent: async (event: Record<string, unknown>) => { audits.push(event); } }));

const {
  opencodeInferenceBaseUrl, parseOpencodeLogin, pollOpencodeDeviceAuth, resolveOpencodeLogin, startOpencodeDeviceAuth,
} = await import('./opencode-console');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const DAY = 24 * 60 * 60 * 1000;
const row = (expires: number) => ({
  storage: 'project' as const, accountId: 'acct', projectId: '11111111-1111-4111-8111-111111111111',
  secretId: 'secret', actorUserId: 'user', sessionId: null,
  value: JSON.stringify({ type: 'oauth', access: 'st_old', refresh: 'rt_old', expires, orgId: 'wrk_1' }),
});

describe('OpenCode Console device flow', () => {
  test('start resolves the relative verification URL against the console', async () => {
    const challenge = await startOpencodeDeviceAuth(async () => json(200, {
      device_code: 'dev', user_code: 'ABCD-EFGH', interval: 5,
      verification_uri_complete: '/console/device?user_code=ABCD-EFGH&client_id=opencode-cli',
    }));
    expect(challenge).toEqual({
      verificationUrl: 'https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli',
      userCode: 'ABCD-EFGH', deviceCode: 'dev', intervalMs: 5000,
    });
  });

  test('poll is pending on authorization_pending and slow_down', async () => {
    for (const error of ['authorization_pending', 'slow_down']) {
      expect(await pollOpencodeDeviceAuth('dev', async () => json(400, { error }))).toEqual({ status: 'pending' });
    }
  });

  test('poll stays pending through a transient console fault', async () => {
    for (const [status, body] of [[400, { error: 'server_error' }], [503, { error: 'temporarily_unavailable' }], [502, {}]] as const) {
      expect(await pollOpencodeDeviceAuth('dev', async () => json(status, body))).toEqual({ status: 'pending' });
    }
  });

  test('poll fails on any other refusal', async () => {
    expect(await pollOpencodeDeviceAuth('dev', async () => json(400, { error: 'expired_token' })))
      .toEqual({ status: 'failed', error: 'OpenCode authorization failed (expired_token)' });
  });

  test('an approved device stores the tokens and the first workspace by name', async () => {
    const calls: string[] = [];
    const result = await pollOpencodeDeviceAuth('dev', async (url) => {
      calls.push(url);
      return url.endsWith('/api/orgs')
        ? json(200, [{ id: 'wrk_z', name: 'Zeta' }, { id: 'wrk_a', name: 'Acme' }])
        : json(200, { access_token: 'st_new', refresh_token: 'rt_new', expires_in: 2592000 });
    });
    expect(result.status).toBe('authorized');
    const login = parseOpencodeLogin((result as { authJson: string }).authJson);
    expect(login).toMatchObject({ type: 'oauth', access: 'st_new', refresh: 'rt_new', orgId: 'wrk_a', orgName: 'Acme' });
    expect(calls).toEqual(['https://opencode.ai/console/auth/device/token', 'https://opencode.ai/console/api/orgs']);
  });
});

describe('stored value', () => {
  test('a plain API key is not a login', () => {
    expect(parseOpencodeLogin('sk-abc')).toBeNull();
    expect(parseOpencodeLogin('{"type":"api","key":"x"}')).toBeNull();
  });

  test('a login is sent to the inference endpoint of its wire format', () => {
    expect(opencodeInferenceBaseUrl('opencode-go', 'openai-compat')).toBe('https://opencode.ai/inference/go/openai/v1');
    expect(opencodeInferenceBaseUrl('opencode-go', 'openai-responses')).toBe('https://opencode.ai/inference/go/openai/v1');
    expect(opencodeInferenceBaseUrl('opencode-go', 'anthropic')).toBe('https://opencode.ai/inference/go/anthropic/v1');
    expect(opencodeInferenceBaseUrl('opencode', 'openai-compat', '@ai-sdk/google')).toBe('https://opencode.ai/inference/google/v1beta');
    expect(opencodeInferenceBaseUrl('openrouter', 'openai-compat')).toBeNull();
  });
});

describe('resolveOpencodeLogin', () => {
  test('a login valid for more than a day is used as stored', async () => {
    const login = await resolveOpencodeLogin(row(Date.now() + 10 * DAY), async () => { throw new Error('no fetch'); });
    expect(login?.access).toBe('st_old');
  });

  test('a login inside the last day is refreshed, persisted, and audited', async () => {
    writes.length = 0; audits.length = 0;
    const login = await resolveOpencodeLogin(row(Date.now() + DAY / 2),
      async () => json(200, { access_token: 'st_fresh', refresh_token: 'rt_fresh', expires_in: 2592000 }));
    expect(login).toMatchObject({ access: 'st_fresh', refresh: 'rt_fresh', orgId: 'wrk_1' });
    expect(writes).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'secret.consumer.refreshed' });
  });

  test('a failed refresh keeps serving a token that has not expired', async () => {
    const login = await resolveOpencodeLogin(row(Date.now() + DAY / 2), async () => json(503, {}));
    expect(login?.access).toBe('st_old');
  });

  test('a dead refresh token on an expired login throws', async () => {
    await expect(resolveOpencodeLogin(row(Date.now() - 1000), async () => json(400, { error: 'invalid_grant' })))
      .rejects.toThrow('invalid_grant');
  });
});
