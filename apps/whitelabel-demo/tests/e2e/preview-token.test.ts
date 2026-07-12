/**
 * `/api/preview-token` — mints a short-lived, project-scoped Kortix PAT for
 * the preview iframe. Ownership-gated before minting; mints via the mock's
 * `cli-token` endpoint using the WRAPPER key, never the caller's own token.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppInstance, loginUser, resetUsersStore, startApp, uniqueEmail } from './harness';
import { createMockUpstream, type MockUpstream } from './mock-upstream';
import { DEMO_PASSWORD, WRAPPER_KEY, wrapperEnv } from './env';

describe('/api/preview-token', () => {
  let mock: MockUpstream;
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    mock = createMockUpstream(WRAPPER_KEY);
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${mock.url}/v1` }));
  }, 30_000);

  afterAll(async () => {
    await app?.stop();
    mock?.stop();
    resetUsersStore();
  });

  test('unauthenticated request is 401', async () => {
    const res = await fetch(`${app.baseUrl}/api/preview-token?projectId=proj_x`);
    expect(res.status).toBe(401);
  });

  test('authenticated but unowned project is 403', async () => {
    const email = uniqueEmail('preview-unowned');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const other = mock.seedProject({ name: 'Not mine' });

    const res = await fetch(`${app.baseUrl}/api/preview-token?projectId=${other.project_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  test('missing projectId is a 400', async () => {
    const email = uniqueEmail('preview-missing-id');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const res = await fetch(`${app.baseUrl}/api/preview-token`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  test('owned project mints a token through the mock cli-token endpoint using the wrapper key', async () => {
    const email = uniqueEmail('preview-owned');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const provision = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Preview Owned' }),
    });
    const project = (await provision.json()) as { project_id: string };

    mock.reset();
    const res = await fetch(`${app.baseUrl}/api/preview-token?projectId=${project.project_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string; upstream: string; tokenId: string };
    expect(data.token).toContain(`kortix_pat_test_${project.project_id}`);
    expect(data.upstream).toBe(`${mock.url}/v1`);
    expect(typeof data.tokenId).toBe('string');

    // The mock must have received exactly one POST .../cli-token, authenticated
    // with the operator's wrapper key (never the end user's session token).
    const cliTokenCalls = mock.requests.filter((r) => r.path.endsWith('/cli-token'));
    expect(cliTokenCalls).toHaveLength(1);
    expect(cliTokenCalls[0]!.method).toBe('POST');
    expect(cliTokenCalls[0]!.authorization).toBe(`Bearer ${WRAPPER_KEY}`);
    expect(mock.authViolations).toHaveLength(0);
  });

  test('a 200 upstream response missing secret_key is a 502, never a token-less 200', async () => {
    const email = uniqueEmail('preview-malformed');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const provision = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Preview Malformed' }),
    });
    const project = (await provision.json()) as { project_id: string };
    mock.malformCliTokenFor(project.project_id);

    const res = await fetch(`${app.baseUrl}/api/preview-token?projectId=${project.project_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // The preview panel only checks `res.ok` — a 200 with `token: undefined`
    // would silently build a broken preview URL. Malformed success must fail loud.
    expect(res.status).toBe(502);
    const data = (await res.json()) as { error?: string; token?: string };
    expect(data.error).toBeTruthy();
    expect(data.token).toBeUndefined();
  });
});
