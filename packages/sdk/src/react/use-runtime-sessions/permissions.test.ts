import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The global reply helpers answer through the ACTIVE session's runtime, on its
// session-log action routes (`runtime.actions.v1`).
const RUNTIME = 'http://api.test/v1/p/sbx_1/8000';
const sent: Array<{ method: string; path: string; body: unknown }> = [];
let answers: Record<string, () => Response> = {};

mock.module('../../core/session/server-store/active', () => ({ getActiveRuntimeUrl: () => RUNTIME }));
mock.module('../../core/http/auth', () => ({
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace('/v1/p/sbx_1/8000', '');
    const text = await request.text();
    sent.push({ method: request.method, path, body: text ? JSON.parse(text) : null });
    return answers[`${request.method} ${path}`]?.() ?? Response.json({ ok: true });
  },
}));
const { allowAllPermissionsForSession, rejectQuestion, replyToPermission, replyToQuestion, resetSessionPermissions } =
  await import('./permissions');

beforeEach(() => {
  sent.length = 0;
  answers = {};
});

describe('the action routes', () => {
  test('replies, question answers and grants go to the action routes', async () => {
    await replyToPermission('perm_1', 'always', 'ok');
    await replyToQuestion('que_1', [['A']]);
    await rejectQuestion('que_2');
    await allowAllPermissionsForSession('ses_root');
    await resetSessionPermissions('ses_root');
    expect(sent).toEqual([
      { method: 'POST', path: '/kortix/runtime/permissions/perm_1/reply', body: { reply: 'always', message: 'ok' } },
      { method: 'POST', path: '/kortix/runtime/questions/que_1/reply', body: { answers: [['A']] } },
      { method: 'POST', path: '/kortix/runtime/questions/que_2/reject', body: null },
      { method: 'PUT', path: '/kortix/runtime/sessions/ses_root/grants', body: { grants: ['*'] } },
      { method: 'PUT', path: '/kortix/runtime/sessions/ses_root/grants', body: { grants: [] } },
    ]);
  });

  test('a permission request another tab already answered resolves; any other refusal throws', async () => {
    answers['POST /kortix/runtime/permissions/perm_gone/reply'] = () => Response.json({ error: 'no such permission request' }, { status: 404 });
    await replyToPermission('perm_gone', 'once');
    // A 404 that is not the reply route's own answer (the proxy lost the sandbox) never reads as answered.
    answers['POST /kortix/runtime/permissions/perm_lost/reply'] = () => Response.json({ error: 'sandbox not found' }, { status: 404 });
    await expect(replyToPermission('perm_lost', 'once')).rejects.toThrow('sandbox not found');
    answers['POST /kortix/runtime/permissions/perm_down/reply'] = () => Response.json({ error: 'pi runtime is not started' }, { status: 503 });
    await expect(replyToPermission('perm_down', 'once')).rejects.toThrow('pi runtime is not started');
    answers['POST /kortix/runtime/questions/que_gone/reply'] = () => Response.json({ error: 'unknown question' }, { status: 404 });
    await expect(replyToQuestion('que_gone', [['A']])).rejects.toThrow('unknown question');
  });
});

