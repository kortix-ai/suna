import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  cancelAccountDeletion,
  convertPresentationToGoogleSlides,
  deleteAccountImmediately,
  getAccountDeletionStatus,
  getAdminProviderDistribution,
  getAdminRole,
  getGoogleAuthUrl,
  requestAccountDeletion,
  setAdminProviderFallback,
} from '.';

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
    });
    return new Response(JSON.stringify({ success: true, isAdmin: true, auth_url: 'https://google.test' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('account lifecycle and admin role methods own their REST paths', async () => {
  await getAccountDeletionStatus();
  await requestAccountDeletion('reason');
  await cancelAccountDeletion();
  await deleteAccountImmediately();
  await getAdminRole();

  expect(calls.map((call) => call.url)).toEqual([
    'http://test.local/account/deletion-status',
    'http://test.local/account/request-deletion',
    'http://test.local/account/cancel-deletion',
    'http://test.local/account/delete-immediately',
    'http://test.local/user-roles',
  ]);
});

test('provider administration and presentation methods own their REST paths', async () => {
  await getAdminProviderDistribution();
  await setAdminProviderFallback(true);
  await getGoogleAuthUrl('https://app.test/workspace');
  await convertPresentationToGoogleSlides('/tmp/deck.pptx', 'https://sandbox.test');

  expect(calls.map((call) => call.url)).toEqual([
    'http://test.local/admin/api/provider-distribution',
    'http://test.local/admin/api/provider-fallback',
    'http://test.local/google/auth-url?return_url=https%3A%2F%2Fapp.test%2Fworkspace',
    'http://test.local/presentation-tools/convert-and-upload-to-slides',
  ]);
});
