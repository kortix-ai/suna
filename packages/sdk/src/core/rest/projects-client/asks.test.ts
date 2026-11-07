import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { answerSessionAsk, listSessionAsks } from './asks';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify(nextResponse.body), { status: nextResponse.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;

test('listSessionAsks GETs the open asks, scoped to a surface session when given', async () => {
  const ask = { id: 'permission:a1', kind: 'permission' as const, session_id: 'w1', surface_session_id: 's1', request_id: 'perm_1', title: 'bash: ls', asked_at: '2026-11-04T00:00:00Z', expires_at: null, session_title: null };
  nextResponse = { status: 200, body: { asks: [ask], total: 1 } };
  const all = await listSessionAsks('P1');
  expect(last().url).toBe('http://test.local/workspaces/P1/asks');
  expect(last().method).toBe('GET');
  expect(all.asks).toEqual([ask]);

  await listSessionAsks('P1', { surfaceSessionId: 's 1' });
  const scoped = new URL(last().url);
  expect(scoped.pathname).toBe('/workspaces/P1/asks');
  expect(scoped.searchParams.get('surface_session_id')).toBe('s 1');
});

test('answerSessionAsk POSTs a question answer, a dismissal, or a permission reply to the ask', async () => {
  nextResponse = { status: 200, body: { ok: true, delivery: 'queued' } };
  expect(await answerSessionAsk('P1', 'question:q1', { answers: [['eu-west-1']] })).toEqual({ ok: true, delivery: 'queued' });
  expect(last().url).toBe('http://test.local/workspaces/P1/asks/question%3Aq1/answer');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ answers: [['eu-west-1']] });

  await answerSessionAsk('P1', 'question:q1', { dismiss: true });
  expect(last().body).toEqual({ dismiss: true });
  await answerSessionAsk('P1', 'permission:a1', { reply: 'always' });
  expect(last().body).toEqual({ reply: 'always' });
});

test('answerSessionAsk throws the API error of an ask already decided', async () => {
  nextResponse = { status: 409, body: { error: 'This ask was already decided', code: 'ALREADY_DECIDED' } };
  await expect(answerSessionAsk('P1', 'permission:a1', { reply: 'once' })).rejects.toThrow('This ask was already decided');
});
