import { beforeEach, expect, mock, test } from 'bun:test';

import { resolveFirstProjectPathForNewUser } from './bootstrap-first-project';

let responses: Response[] = [];

beforeEach(() => {
  responses = [];
  globalThis.fetch = mock(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more mocked responses queued');
    return next;
  }) as unknown as typeof fetch;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OPTS = { backendUrl: 'http://backend.test/v1', accessToken: 'tok', isNewUser: true };

test('returns null (safe /projects fallback) when provision reports ok but the body has no project_id', async () => {
  responses = [
    jsonResponse([{ account_id: 'acc-1' }]), // GET /accounts
    jsonResponse([]), // GET /projects?account_id= — none yet
    jsonResponse({ name: 'My First Project' }, 200), // POST /projects/provision — 200 but NO project_id
  ];

  const path = await resolveFirstProjectPathForNewUser(OPTS);
  expect(path).toBeNull();
});

test('builds /projects/{id} when provision succeeds with a real project_id', async () => {
  responses = [
    jsonResponse([{ account_id: 'acc-1' }]),
    jsonResponse([]),
    jsonResponse({ project_id: 'proj-123' }, 200),
  ];

  const path = await resolveFirstProjectPathForNewUser(OPTS);
  expect(path).toBe('/projects/proj-123');
});

test('returns null for an existing user (not a new signup)', async () => {
  const path = await resolveFirstProjectPathForNewUser({ ...OPTS, isNewUser: false });
  expect(path).toBeNull();
});
