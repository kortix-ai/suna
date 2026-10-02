import { beforeEach, describe, expect, mock, test } from 'bun:test';

const rows: Array<Record<string, unknown>> = [];
mock.module('./audit', () => ({
  recordAuditEvent: async (event: Record<string, unknown>) => {
    rows.push(event);
  },
}));

const { auditLoginFail, auditLoginSuccess } = await import('./auth-audit');

function ctx(vars: Record<string, unknown>): any {
  return { get: (k: string) => vars[k], req: { header: () => undefined } };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const actions = () => rows.map((r) => r.action);

describe('auth.login.success is written once per credential per hour', () => {
  beforeEach(() => {
    rows.length = 0;
  });

  test('a repeat use of the same browser session is not written again', async () => {
    const c = ctx({ authType: 'supabase', sessionId: 'sess-repeat' });
    for (let i = 0; i < 5; i += 1) auditLoginSuccess({ c, userId: 'u1', authType: 'supabase' });
    await flush();
    expect(actions()).toEqual(['auth.login.success']);
  });

  test('a different credential is written on its first use', async () => {
    auditLoginSuccess({ c: ctx({ authType: 'supabase', sessionId: 'sess-a' }), userId: 'u2', authType: 'supabase' });
    auditLoginSuccess({ c: ctx({ authType: 'supabase', sessionId: 'sess-b' }), userId: 'u2', authType: 'supabase' });
    auditLoginSuccess({ c: ctx({ authType: 'pat', iamTokenId: 'tok-1' }), userId: 'u2', authType: 'pat' });
    await flush();
    expect(actions()).toHaveLength(3);
  });

  test('a login failure is always written', async () => {
    for (let i = 0; i < 3; i += 1) auditLoginFail({ c: ctx({}), reason: 'bad_token' });
    await flush();
    expect(actions()).toEqual(['auth.login.fail', 'auth.login.fail', 'auth.login.fail']);
  });
});
