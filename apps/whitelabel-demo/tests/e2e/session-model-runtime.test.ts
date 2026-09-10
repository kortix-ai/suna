import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { DEMO_PASSWORD, WRAPPER_KEY, wrapperEnv } from './env';
import {
  APP_SETUP_TIMEOUT_MS,
  type AppInstance,
  createTestKortix,
  loginUser,
  resetUsersStore,
  startApp,
  uniqueEmail,
} from './harness';
import { type MockUpstream, createMockUpstream } from './mock-upstream';

const SESSION_ID = '00000000-0000-4000-8000-00000000d001';

describe('session model runtime gate', () => {
  let upstream: MockUpstream;
  let app: AppInstance;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    resetUsersStore();
    upstream = createMockUpstream(WRAPPER_KEY);
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${upstream.url}/v1` }));
    token = await loginUser(app, uniqueEmail('runtime-model'), DEMO_PASSWORD);
    const kortix = createTestKortix(app, token);
    projectId = (await kortix.projects.provision({ name: 'Runtime policy project' })).project_id;
  }, APP_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.stop();
    upstream?.stop();
    resetUsersStore();
  });

  test('rejects a Pi model change before the mutation reaches Kortix', async () => {
    upstream.seedSession(projectId, SESSION_ID, { pi_worker_boot: true });
    upstream.reset();

    const response = await changeModel('kortix/model-a');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'SESSION_MODEL_FIXED_AT_START',
    });
    expect(
      upstream.requests.filter(
        (request) => request.method === 'PUT' && request.path.endsWith('/model'),
      ),
    ).toHaveLength(0);
  });

  test('keeps live model changes for a mutable session', async () => {
    upstream.seedSession(projectId, SESSION_ID, {});
    upstream.reset();

    const response = await changeModel('kortix/model-b');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model: 'kortix/model-b',
      appliedLive: true,
    });
    expect(
      upstream.requests.filter(
        (request) => request.method === 'PUT' && request.path.endsWith('/model'),
      ),
    ).toHaveLength(1);
  });

  function changeModel(model: string): Promise<Response> {
    return fetch(
      `${app.baseUrl}/api/session-model?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(SESSION_ID)}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model }),
      },
    );
  }
});
