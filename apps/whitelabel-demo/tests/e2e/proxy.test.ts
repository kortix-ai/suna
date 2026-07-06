/**
 * The BFF proxy (`/api/kortix/[...path]`) itself: auth gate, key substitution,
 * cookie stripping in both directions, request-body buffering integrity (the
 * ALB/chunked-body regression), and SSE response streaming (the "response
 * bodies still stream" regression).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppInstance, loginUser, resetUsersStore, startApp, uniqueEmail } from './harness';
import { createMockUpstream, type MockUpstream } from './mock-upstream';
import { DEMO_PASSWORD, WRAPPER_KEY, wrapperEnv } from './env';

describe('BFF proxy', () => {
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

  test('unauthenticated request to the proxy is 401 and never reaches upstream', async () => {
    mock.reset();
    const res = await fetch(`${app.baseUrl}/api/kortix/accounts/me`);
    expect(res.status).toBe(401);
    expect(mock.requests).toHaveLength(0);
  });

  test('a valid session is forwarded with the WRAPPER key substituted in; the user token never reaches upstream', async () => {
    mock.reset();
    const email = uniqueEmail('proxy-auth');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const res = await fetch(`${app.baseUrl}/api/kortix/accounts/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ account_id: 'acct_test', name: 'Test Account' });

    expect(mock.requests).toHaveLength(1);
    const upstreamReq = mock.requests[0]!;
    expect(upstreamReq.authorization).toBe(`Bearer ${WRAPPER_KEY}`);
    // The end user's own session token must not appear anywhere upstream.
    expect(upstreamReq.authorization).not.toContain(token);
    expect(mock.authViolations).toHaveLength(0);
  });

  test("the wrapper's own session cookie is stripped before forwarding upstream", async () => {
    mock.reset();
    const email = uniqueEmail('cookie-strip-req');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const res = await fetch(`${app.baseUrl}/api/kortix/accounts/me`, {
      headers: {
        authorization: `Bearer ${token}`,
        cookie: `lumen_session=${encodeURIComponent(token)}`,
      },
    });
    expect(res.status).toBe(200);
    expect(mock.cookieViolations).toHaveLength(0);
    expect(mock.requests.at(-1)!.cookie).toBeNull();
  });

  test("upstream's Set-Cookie never reaches the browser", async () => {
    mock.reset();
    const email = uniqueEmail('cookie-strip-res');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const provision = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Cookie Strip Test' }),
    });
    expect(provision.status).toBe(201);
    const project = (await provision.json()) as { project_id: string };

    // The mock deliberately sets `Set-Cookie: upstream_session=leak-me` on the
    // project-detail GET — this is the passthrough (non-buffered) response
    // path, which is where `route.ts` explicitly strips `set-cookie`.
    const detail = await fetch(`${app.baseUrl}/api/kortix/projects/${project.project_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.status).toBe(200);
    expect(detail.headers.get('set-cookie')).toBeNull();
  });

  test('request body integrity: POST body arrives at upstream byte-for-byte with Content-Length (never chunked)', async () => {
    mock.reset();
    const email = uniqueEmail('body-integrity');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const payload = { hello: 'world', big: 'x'.repeat(20_000), n: 12345 };
    const bodyText = JSON.stringify(payload);

    const res = await fetch(`${app.baseUrl}/api/kortix/p/sbx_body/8000/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: bodyText,
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { content: string };
    expect(echoed.content).toBe(`echo: ${bodyText}`);

    expect(mock.requests).toHaveLength(1);
    const upstreamReq = mock.requests[0]!;
    expect(upstreamReq.body).toEqual(payload);
    expect(upstreamReq.transferEncoding).toBeNull();
    expect(upstreamReq.contentLength).toBe(String(Buffer.byteLength(bodyText, 'utf8')));
  });

  test('SSE pass-through: events arrive unbuffered, connection stays open past the first burst', async () => {
    mock.reset();
    const email = uniqueEmail('sse');
    const token = await loginUser(app, email, DEMO_PASSWORD);

    const start = Date.now();
    const res = await fetch(`${app.baseUrl}/api/kortix/p/sbx_sse/8000/global/event`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';

    // First chunk should arrive fast — proves the response isn't buffered
    // whole before being sent to the client.
    const first = await reader.read();
    const firstEventElapsedMs = Date.now() - start;
    expect(first.done).toBe(false);
    buffered += decoder.decode(first.value!, { stream: true });
    expect(buffered).toContain('event: message');
    expect(firstEventElapsedMs).toBeLessThan(1_000);

    // Keep reading until we've seen a heartbeat too — proves the connection
    // stays open beyond the initial burst rather than closing right away.
    const deadline = Date.now() + 3_000;
    while (!buffered.includes('heartbeat') && Date.now() < deadline) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value!, { stream: true });
    }
    expect(buffered).toContain('heartbeat');

    await reader.cancel();
  });
});
