import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The global reply helpers answer through the ACTIVE session's runtime: the
// session-log action routes on a box that lists `runtime.actions.v1`, the
// compatibility client on an older one.
const RUNTIME = 'http://api.test/v1/p/sbx_1/8000';
let capabilities: string[] = [];
const sent: Array<{ method: string; path: string; body: unknown }> = [];
let answers: Record<string, () => Response> = {};
const compatibility: Array<[string, unknown]> = [];

mock.module('../../core/session/server-store/active', () => ({ getActiveRuntimeUrl: () => RUNTIME }));
mock.module('../../core/http/auth', () => ({
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace('/v1/p/sbx_1/8000', '');
    if (path === '/kortix/health') return Response.json({ capabilities });
    const text = await request.text();
    sent.push({ method: request.method, path, body: text ? JSON.parse(text) : null });
    return answers[`${request.method} ${path}`]?.() ?? Response.json({ ok: true });
  },
}));
mock.module('../../core/runtime/client', () => ({
  getClient: () => ({
    permission: { reply: async (input: unknown) => (compatibility.push(['permission.reply', input]), { data: true }) },
    question: {
      reply: async (input: unknown) => (compatibility.push(['question.reply', input]), { data: true }),
      reject: async (input: unknown) => (compatibility.push(['question.reject', input]), { data: true }),
    },
    session: { update: async (input: unknown) => (compatibility.push(['session.update', input]), { data: {} }) },
  }),
}));

const { __resetRuntimeActionsMemo } = await import('../../core/session/runtime-actions');
const { allowAllPermissionsForSession, rejectQuestion, replyToPermission, replyToQuestion, resetSessionPermissions } =
  await import('./permissions');

beforeEach(() => {
  __resetRuntimeActionsMemo();
  sent.length = 0;
  compatibility.length = 0;
  answers = {};
});

describe('on a box with the session-log actions', () => {
  beforeEach(() => {
    capabilities = ['runtime.actions.v1'];
  });

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
    expect(compatibility).toEqual([]);
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

test('an older box is answered through the compatibility client', async () => {
  capabilities = ['runtime.turns.v1'];
  await replyToPermission('per_1', 'once');
  await replyToQuestion('que_1', [['A']]);
  await rejectQuestion('que_2');
  expect(sent).toEqual([]);
  expect(compatibility.map(([verb]) => verb)).toEqual(['permission.reply', 'question.reply', 'question.reject']);
});
