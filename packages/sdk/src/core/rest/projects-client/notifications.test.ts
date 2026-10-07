import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { registerDeviceToken, unregisterDeviceToken } from './notifications';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });

test('registerDeviceToken POSTs the token, platform and preferences', async () => {
  nextResponse = { status: 200, body: { success: true, message: 'Device token registered' } };
  const result = await registerDeviceToken({
    device_token: 'ExponentPushToken[abc]',
    device_type: 'ios',
    provider: 'expo',
    preferences: { enabled: true, on_question: false },
  });
  expect(calls[0]).toMatchObject({
    url: 'http://test.local/v1/notifications/device-token',
    method: 'POST',
    body: {
      device_token: 'ExponentPushToken[abc]',
      device_type: 'ios',
      provider: 'expo',
      preferences: { enabled: true, on_question: false },
    },
  });
  expect(result).toEqual({ success: true, message: 'Device token registered' });
});

test('unregisterDeviceToken DELETEs the encoded token', async () => {
  nextResponse = { status: 200, body: { success: true, deleted: true } };
  const result = await unregisterDeviceToken('ExponentPushToken[a/b]');
  expect(calls[0]?.url).toBe('http://test.local/v1/notifications/device-token/ExponentPushToken%5Ba%2Fb%5D');
  expect(calls[0]?.method).toBe('DELETE');
  expect(result).toEqual({ success: true, deleted: true });
});

test('unregisterDeviceToken honours the caller abort signal (the sign-out deadline)', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(unregisterDeviceToken('t', { signal: controller.signal })).rejects.toBeTruthy();
  expect(calls).toHaveLength(0);
});

test('registerDeviceToken throws on a 403 (a service account cannot bind a device)', async () => {
  nextResponse = { status: 403, body: { error: true, message: 'Device tokens require a signed-in user' } };
  await expect(
    registerDeviceToken({ device_token: 't', device_type: 'android', provider: 'expo' }),
  ).rejects.toBeTruthy();
});
