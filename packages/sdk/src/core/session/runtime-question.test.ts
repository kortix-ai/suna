import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../http/config';
import { answerSessionRuntimeQuestion, externalIdFromSandboxUrl } from './runtime-question';

let calls: { url: string; method: string; body: unknown }[] = [];
let routes: Record<string, { status?: number; body: unknown }> = {};

beforeEach(() => {
  calls = [];
  routes = {};
  globalThis.fetch = mock(async (input: unknown, opts: { method?: string; body?: string } = {}) => {
    // The opencode client passes a Request; the Kortix REST client passes a url string.
    const req = input instanceof Request ? input : null;
    const u = req ? req.url : String(input);
    const method = req?.method ?? opts.method ?? 'GET';
    const raw = req ? await req.clone().text() : opts.body;
    calls.push({ url: u, method, body: raw ? JSON.parse(raw) : undefined });
    const hit = Object.entries(routes).find(([key]) => `${method} ${u}`.includes(key));
    const res = hit?.[1] ?? { status: 404, body: { error: `no route for ${method} ${u}` } };
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const running = {
  session_id: 'S1',
  status: 'running',
  opencode_session_id: 'ses_1',
  sandbox_url: 'https://tunnel.example/v1/p/sbx_abc/8000',
};

test('externalIdFromSandboxUrl reads the provider id out of the proxy url', () => {
  expect(externalIdFromSandboxUrl('https://x.example/v1/p/sbx_abc/8000')).toBe('sbx_abc');
  expect(externalIdFromSandboxUrl('https://x.example/v1/p/sbx_abc/8000/')).toBe('sbx_abc');
  expect(externalIdFromSandboxUrl(null)).toBeNull();
  expect(externalIdFromSandboxUrl('https://x.example/nothing')).toBeNull();
});

test('answers the runtime question that belongs to this session, one answer per question', async () => {
  routes['GET http://test.local/projects/P1/sessions/S1'] = { body: running };
  routes['GET http://test.local/p/sbx_abc/8000/question'] = {
    body: [
      { id: 'q-other', sessionID: 'ses_other', questions: [{ question: 'x', options: [] }] },
      {
        id: 'q-1',
        sessionID: 'ses_1',
        questions: [
          { question: 'Approve the plan?', options: [] },
          { question: 'Which license?', options: [{ label: 'MIT' }] },
        ],
      },
    ],
  };
  routes['POST http://test.local/p/sbx_abc/8000/question/q-1/reply'] = { body: true };

  const result = await answerSessionRuntimeQuestion('P1', 'S1', 'Approved. Proceed.');
  expect(result).toBe('answered');
  const reply = calls.find((c) => c.url.endsWith('/question/q-1/reply'));
  expect(reply?.method).toBe('POST');
  expect(reply?.body).toEqual({ answers: [['Approved. Proceed.'], ['Approved. Proceed.']] });
});

test('reports none when the session has no pending runtime question', async () => {
  routes['GET http://test.local/projects/P1/sessions/S1'] = { body: running };
  routes['GET http://test.local/p/sbx_abc/8000/question'] = { body: [] };
  expect(await answerSessionRuntimeQuestion('P1', 'S1', 'ok')).toBe('none');
  expect(calls.some((c) => c.url.includes('/reply'))).toBe(false);
});

test('reports none without touching the runtime when the session is not running', async () => {
  routes['GET http://test.local/projects/P1/sessions/S1'] = {
    body: { ...running, status: 'stopped' },
  };
  expect(await answerSessionRuntimeQuestion('P1', 'S1', 'ok')).toBe('none');
  expect(calls.some((c) => c.url.includes('/8000/'))).toBe(false);
});
