/**
 * `/api/preview-url` resolves a session preview on the server.
 *
 * The route owns session readiness, proxy URL resolution, and scoped-token
 * minting. The browser receives one final URL. It never receives transport
 * coordinates or a standalone credential.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  APP_SETUP_TIMEOUT_MS,
  type AppInstance,
  createTestKortix,
  loginUser,
  resetUsersStore,
  startApp,
  uniqueEmail,
} from './harness';
import { createMockUpstream, type MockUpstream } from './mock-upstream';
import { DEMO_PASSWORD, WRAPPER_KEY, wrapperEnv } from './env';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';

describe('/api/preview-url', () => {
  let mock: MockUpstream;
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    mock = createMockUpstream(WRAPPER_KEY);
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${mock.url}/v1` }));
  }, APP_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.stop();
    mock?.stop();
    resetUsersStore();
  });

  test('unauthenticated request is 401', async () => {
    const res = await fetch(`${app.baseUrl}/api/preview-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: '00000000-0000-4000-8000-000000000001',
        sessionId: SESSION_ID,
        preview: { port: 3000, path: '/' },
      }),
    });
    expect(res.status).toBe(401);
  });

  test('authenticated but unowned workspace is 403', async () => {
    const email = uniqueEmail('preview-unowned');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const other = mock.seedWorkspace({ name: 'Not mine' });

    const res = await fetch(`${app.baseUrl}/api/preview-url`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: other.workspace_id,
        sessionId: SESSION_ID,
        preview: { port: 3000, path: '/' },
      }),
    });
    expect(res.status).toBe(403);
  });

  test('invalid input is a 400', async () => {
    const email = uniqueEmail('preview-invalid-input');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const res = await fetch(`${app.baseUrl}/api/preview-url`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'not-a-workspace',
        sessionId: '',
        preview: { port: 0, path: '/' },
      }),
    });
    expect(res.status).toBe(400);
  });

  test('owned workspace returns one final preview URL through server-side SDK calls', async () => {
    const email = uniqueEmail('preview-owned');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const workspace = await createTestKortix(app, token).workspaces.provision({
      name: 'Preview Owned',
    });

    mock.reset();
    const res = await fetch(`${app.baseUrl}/api/preview-url`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: workspace.workspace_id,
        sessionId: SESSION_ID,
        preview: { port: 3000, path: '/docs?section=setup' },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      url: string;
      tokenId: string;
      token?: string;
      upstream?: string;
      sandboxId?: string;
    };
    const previewUrl = new URL(data.url);
    expect(previewUrl.hostname).toBe(`p3000-session-${SESSION_ID}.localhost`);
    expect(previewUrl.port).toBe(new URL(mock.url).port);
    expect(previewUrl.pathname).toBe('/docs');
    expect(previewUrl.searchParams.get('section')).toBe('setup');
    expect(previewUrl.searchParams.get('token')).toContain(`kortix_pat_test_${workspace.workspace_id}`);
    expect(typeof data.tokenId).toBe('string');
    expect(data.token).toBeUndefined();
    expect(data.upstream).toBeUndefined();
    expect(data.sandboxId).toBeUndefined();

    const startCalls = mock.requests.filter((r) =>
      r.path.includes(`/sessions/${SESSION_ID}/start`),
    );
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.authorization).toBe(`Bearer ${WRAPPER_KEY}`);

    const cliTokenCalls = mock.requests.filter((r) => r.path.endsWith('/cli-token'));
    expect(cliTokenCalls).toHaveLength(1);
    expect(cliTokenCalls[0]!.method).toBe('POST');
    expect(cliTokenCalls[0]!.authorization).toBe(`Bearer ${WRAPPER_KEY}`);
    expect(mock.authViolations).toHaveLength(0);
  });

  test('localhost target resolution stays on the server', async () => {
    const email = uniqueEmail('preview-localhost');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const workspace = await createTestKortix(app, token).workspaces.provision({
      name: 'Preview Localhost',
    });

    const res = await fetch(`${app.baseUrl}/api/preview-url`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: workspace.workspace_id,
        sessionId: '10000000-0000-4000-8000-000000000002',
        targetUrl: 'http://localhost:4173/demo?tab=activity',
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { url: string };
    const previewUrl = new URL(data.url);
    expect(previewUrl.hostname).toBe(
      'p4173-session-10000000-0000-4000-8000-000000000002.localhost',
    );
    expect(previewUrl.port).toBe(new URL(mock.url).port);
    expect(previewUrl.pathname).toBe('/demo');
    expect(previewUrl.searchParams.get('tab')).toBe('activity');
    expect(previewUrl.searchParams.get('token')).toContain(`kortix_pat_test_${workspace.workspace_id}`);
  });

  test('a malformed token response is a 502, never a URL without authentication', async () => {
    const email = uniqueEmail('preview-malformed');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const workspace = await createTestKortix(app, token).workspaces.provision({
      name: 'Preview Malformed',
    });
    mock.malformCliTokenFor(workspace.workspace_id);

    const res = await fetch(`${app.baseUrl}/api/preview-url`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: workspace.workspace_id,
        sessionId: '10000000-0000-4000-8000-000000000003',
        preview: { port: 3000, path: '/' },
      }),
    });
    expect(res.status).toBe(502);
    const data = (await res.json()) as { error?: string; url?: string };
    expect(data.error).toBeTruthy();
    expect(data.url).toBeUndefined();
  });
});

describe('/api/preview-url in direct mode', () => {
  const directKey = 'kortix_pat_direct_test';
  let mock: MockUpstream;
  let app: AppInstance;

  beforeAll(async () => {
    mock = createMockUpstream(directKey);
    app = await startApp({
      KORTIX_API_KEY: undefined,
      SESSION_SECRET: undefined,
      KORTIX_UPSTREAM: `${mock.url}/v1`,
    });
  }, APP_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.stop();
    mock?.stop();
  });

  test('caller token resolves the final URL without wrapper auth or ownership state', async () => {
    const workspaceId = '20000000-0000-4000-8000-000000000001';
    const sessionId = '20000000-0000-4000-8000-000000000002';
    const response = await fetch(`${app.baseUrl}/api/preview-url`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${directKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId,
        sessionId,
        preview: { port: 8080, path: '/health' },
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      url: string;
      tokenId: string;
      token?: string;
      upstream?: string;
    };
    const previewUrl = new URL(data.url);
    expect(previewUrl.hostname).toBe(`p8080-session-${sessionId}.localhost`);
    expect(previewUrl.pathname).toBe('/health');
    expect(previewUrl.searchParams.get('token')).toContain(`kortix_pat_test_${workspaceId}`);
    expect(typeof data.tokenId).toBe('string');
    expect(data.token).toBeUndefined();
    expect(data.upstream).toBeUndefined();
    expect(mock.authViolations).toHaveLength(0);
  });
});
