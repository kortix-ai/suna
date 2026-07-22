import { afterEach, describe, expect, mock, test } from 'bun:test';

// The thin client wires the two-door account flows to the Step-3 credential
// routes via the web `backendApi` (which returns `{ data, error, success }` and
// never throws on an HTTP error). These tests pin the exact URL + body sent and
// the camelCase/verdict normalization, so the route contract has a byte-level
// spec to reconcile against.
let posts: Array<{ url: string; body: unknown }> = [];
let postImpl: (url: string, body: unknown) => any = () => ({
  data: {
    flow_id: 'flow_1',
    verification_url: 'https://auth.example.com/device',
    user_code: 'WXYZ-1234',
    expires_at: 1_000,
    interval_ms: 5_000,
  },
  success: true,
});

mock.module('@/lib/api-client', () => ({
  backendApi: {
    post: async (url: string, body: unknown) => {
      posts.push({ url, body });
      return postImpl(url, body);
    },
  },
}));

const { startAccountFlow, pollAccountFlow } = await import('./auth-flow-client');

afterEach(() => {
  posts = [];
  postImpl = () => ({
    data: {
      flow_id: 'flow_1',
      verification_url: 'https://auth.example.com/device',
      user_code: 'WXYZ-1234',
      expires_at: 1_000,
      interval_ms: 5_000,
    },
    success: true,
  });
});

describe('startAccountFlow', () => {
  test('POSTs the /oauth-credentials/:providerId/start route and normalizes to camelCase', async () => {
    const start = await startAccountFlow('proj_1', 'openai');
    expect(posts).toEqual([{ url: '/projects/proj_1/oauth-credentials/openai/start', body: {} }]);
    expect(start).toEqual({
      flowId: 'flow_1',
      verificationUrl: 'https://auth.example.com/device',
      userCode: 'WXYZ-1234',
      expiresAt: 1_000,
      intervalMs: 5_000,
    });
  });

  test('floors the poll interval to 2s and defaults a missing deadline forward', async () => {
    const before = Date.now();
    postImpl = () => ({
      data: {
        flow_id: 'flow_2',
        verification_url: 'https://auth.example.com/device',
        user_code: null,
        expires_at: 0,
        interval_ms: 500,
      },
      success: true,
    });
    const start = await startAccountFlow('proj_1', 'openai');
    expect(start.intervalMs).toBe(2000);
    expect(start.userCode).toBeNull();
    expect(start.expiresAt).toBeGreaterThanOrEqual(before + 9 * 60_000);
  });

  test('a paste-token provider 400 (Anthropic) surfaces as a thrown error, not a spin', async () => {
    postImpl = () => ({ error: { message: 'use paste flow' }, success: false });
    await expect(startAccountFlow('proj_1', 'anthropic')).rejects.toThrow('use paste flow');
  });
});

describe('pollAccountFlow — every terminal state maps to exactly one UI state', () => {
  test('POSTs the poll route with the flow id in the body', async () => {
    postImpl = () => ({ data: { status: 'pending', next_poll_ms: 3000 }, success: true });
    expect(await pollAccountFlow('proj_1', 'openai', 'flow_1')).toEqual({ status: 'pending' });
    expect(posts).toEqual([
      { url: '/projects/proj_1/oauth-credentials/openai/poll', body: { flow_id: 'flow_1' } },
    ]);
  });

  test('success drops the credential payload — the flow only needs the verdict', async () => {
    postImpl = () => ({
      data: { status: 'success', credential: { provider_id: 'openai' } },
      success: true,
    });
    expect(await pollAccountFlow('proj_1', 'openai', 'flow_1')).toEqual({ status: 'success' });
  });

  test('expired', async () => {
    postImpl = () => ({ data: { status: 'expired' }, success: true });
    expect(await pollAccountFlow('proj_1', 'openai', 'flow_1')).toEqual({ status: 'expired' });
  });

  test('failed carries the error string through', async () => {
    postImpl = () => ({ data: { status: 'failed', error: 'access_denied' }, success: true });
    expect(await pollAccountFlow('proj_1', 'openai', 'flow_1')).toEqual({
      status: 'failed',
      error: 'access_denied',
    });
  });

  test('failed with no error string falls back to a generic message', async () => {
    postImpl = () => ({ data: { status: 'failed' }, success: true });
    expect(await pollAccountFlow('proj_1', 'openai', 'flow_1')).toEqual({
      status: 'failed',
      error: 'Authorization failed',
    });
  });

  test('a transport error is treated as still-pending (a blip never aborts a sign-in)', async () => {
    postImpl = () => ({ error: { message: 'network' }, success: false });
    expect(await pollAccountFlow('proj_1', 'openai', 'flow_1')).toEqual({ status: 'pending' });
  });

  test('an unrecognized status is treated as still-pending (never a false terminal)', async () => {
    postImpl = () => ({ data: { status: 'something-new' }, success: true });
    expect(await pollAccountFlow('proj_1', 'openai', 'flow_1')).toEqual({ status: 'pending' });
  });
});
