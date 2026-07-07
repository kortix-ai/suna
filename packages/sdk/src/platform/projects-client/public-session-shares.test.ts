import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import {
  PublicSessionShareError,
  getPublicSessionShare,
  getPublicSessionShareMessages,
} from './public-session-shares';

let calls: { url: string; method: string; headers: Record<string, string> }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; headers?: Record<string, string> } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', headers: opts.headers ?? {} });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('getPublicSessionShare hits /public/session-shares/:shareId with no Authorization header', async () => {
  nextResponse = {
    status: 200,
    body: {
      share: { share_id: 'S1', session_id: 'sess1', project_id: 'p1', resource_type: 'preview', label: 'x', sandbox_status: 'active', expires_at: null },
      session: { session_id: 'sess1', title: 'Hello', status: 'running', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    },
  };
  const result = await getPublicSessionShare('S1');
  expect(last().url).toBe('http://test.local/public/session-shares/S1');
  expect(last().method).toBe('GET');
  expect(last().headers.Authorization).toBeUndefined();
  expect(result.session.title).toBe('Hello');
  expect(result.share.share_id).toBe('S1');
});

test('getPublicSessionShareMessages hits the /messages suffix', async () => {
  nextResponse = {
    status: 200,
    body: { available: true, reason: null, opencode_session_id: 'oc1', message_count: 1, messages: [{ role: 'user', created: null, completed: null, text: 'hi', tools: [], files: [], reasoning_omitted: false }] },
  };
  const result = await getPublicSessionShareMessages('S1');
  expect(last().url).toBe('http://test.local/public/session-shares/S1/messages');
  expect(result.message_count).toBe(1);
  expect(result.messages[0].text).toBe('hi');
});

test('getPublicSessionShare throws a PublicSessionShareError carrying the status on 404', async () => {
  nextResponse = { status: 404, body: { error: 'Share link not found' } };
  await expect(getPublicSessionShare('unknown')).rejects.toThrow('Share link not found');
  try {
    await getPublicSessionShare('unknown');
    throw new Error('expected a rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(PublicSessionShareError);
    expect((err as PublicSessionShareError).status).toBe(404);
  }
});

test('getPublicSessionShare surfaces 410 (revoked) with the status preserved', async () => {
  nextResponse = { status: 410, body: { error: 'Share link revoked' } };
  try {
    await getPublicSessionShare('revoked');
    throw new Error('expected a rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(PublicSessionShareError);
    expect((err as PublicSessionShareError).status).toBe(410);
    expect((err as Error).message).toBe('Share link revoked');
  }
});

test('getPublicSessionShareMessages surfaces 503 (sandbox not ready)', async () => {
  nextResponse = { status: 503, body: { error: 'Sandbox is not ready' } };
  try {
    await getPublicSessionShareMessages('S1');
    throw new Error('expected a rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(PublicSessionShareError);
    expect((err as PublicSessionShareError).status).toBe(503);
  }
});
