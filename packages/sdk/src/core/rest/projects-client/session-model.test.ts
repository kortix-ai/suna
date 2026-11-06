import { beforeEach, expect, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import * as sessions from './sessions';

beforeEach(() => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'synthetic-token' });
});

test('getProjectSessionModel reads the durable session pin without changing it', async () => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return Response.json({ session_id: 'synthetic-session', metadata: { model: 'kortix/synthetic-model' } });
  }, { preconnect: globalThis.fetch.preconnect });
  expect(await sessions.getWorkspaceSessionModel('synthetic-project', 'synthetic-session')).toEqual({ model: 'kortix/synthetic-model' });
  expect(requests).toEqual(['GET http://test.local/workspaces/synthetic-project/sessions/synthetic-session']);
});

test('getProjectSessionModel reports an unpinned session as null', async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ session_id: 'synthetic-session', metadata: {} }), { preconnect: globalThis.fetch.preconnect });
  expect(await sessions.getWorkspaceSessionModel('synthetic-project', 'synthetic-session')).toEqual({ model: null });
});

test('switchProjectSessionModel sends the prompt and retry key in one request', async () => {
  let requestBody: unknown;
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ model: 'kortix/synthetic-next', applied_live: false, prompt_id: 'synthetic-prompt', deduped: true });
  }, { preconnect: globalThis.fetch.preconnect });
  const result = await sessions.switchWorkspaceSessionModel('synthetic-project', 'synthetic-session', {
    model: 'kortix/synthetic-next', prompt: 'Continue verification', idempotency_key: 'synthetic-retry',
  });
  expect(requestBody).toEqual({ model: 'kortix/synthetic-next', prompt: 'Continue verification', idempotency_key: 'synthetic-retry' });
  expect(result.prompt_id).toBe('synthetic-prompt');
  expect(result.deduped).toBe(true);
});
