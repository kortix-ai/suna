/**
 * BFF verification through the public SDK.
 *
 * The app never constructs Kortix routes. Low-level request buffering,
 * response-header sanitization, and stream forwarding live in
 * `forwardKortixRequest()` and have focused SDK tests.
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

describe('BFF SDK transport', () => {
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

  async function authenticatedClient(prefix: string) {
    const token = await loginUser(
      app,
      uniqueEmail(prefix),
      DEMO_PASSWORD,
    );
    return createTestKortix(app, token);
  }

  test('an invalid wrapper token is rejected before any upstream request', async () => {
    mock.reset();
    const kortix = createTestKortix(app, 'invalid-wrapper-session');

    await expect(kortix.projects.list()).rejects.toMatchObject({ status: 401 });
    expect(mock.requests).toHaveLength(0);
  });

  test('the BFF substitutes the operator token for the wrapper user token', async () => {
    mock.reset();
    const kortix = await authenticatedClient('proxy-auth');

    expect((await kortix.validateToken()).valid).toBe(true);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.authorization).toBe(`Bearer ${WRAPPER_KEY}`);
    expect(mock.authViolations).toHaveLength(0);
  });

  test('SDK request bodies arrive byte-for-byte with Content-Length', async () => {
    const kortix = await authenticatedClient('body-integrity');
    mock.reset();
    const name = `Runtime ${'x'.repeat(20_000)}`;

    const project = await kortix.projects.provision({ name });

    expect(project.name).toBe(name);
    expect(mock.requests).toHaveLength(1);
    const upstreamRequest = mock.requests[0]!;
    const expectedBody = JSON.stringify({ seed_starter: true, name });
    expect(upstreamRequest.body).toEqual({ seed_starter: true, name });
    expect(upstreamRequest.transferEncoding).toBeNull();
    expect(upstreamRequest.contentLength).toBe(
      String(Buffer.byteLength(expectedBody, 'utf8')),
    );
  });

  test('SDK reads force identity response encoding through the BFF', async () => {
    const kortix = await authenticatedClient('response-encoding');
    mock.reset();

    await kortix.projects.list();

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.acceptEncoding).toBe('identity');
  });

  test('SDK session.stream receives unbuffered events and remains open', async () => {
    const kortix = await authenticatedClient('sse');
    const project = await kortix.projects.provision({ name: 'Runtime SSE' });
    const session = kortix.session(project.project_id, 'sse-session');
    await session.start();
    mock.reset();

    const events: unknown[] = [];
    let resolveFirstEvent = () => {};
    const firstEvent = new Promise<void>((resolve) => {
      resolveFirstEvent = resolve;
    });
    const stream = await session.stream({
      onEvent(event) {
        events.push(event);
        resolveFirstEvent();
      },
    });

    try {
      await Promise.race([
        firstEvent,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('SDK stream did not deliver an event within 1 second')),
            1_000,
          ),
        ),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(events.length).toBeGreaterThan(0);
      expect(
        mock.requests.some((request) => request.path.endsWith('/global/event')),
      ).toBe(true);
    } finally {
      stream.close();
    }
  });
});
