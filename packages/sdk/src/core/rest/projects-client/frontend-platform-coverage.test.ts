import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  cancelAccountDeletion,
  deleteAccountImmediately,
  getAccountDeletionStatus,
  getAdminProviderDistribution,
  getAdminRole,
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
    return new Response(JSON.stringify({ success: true, isAdmin: true }), {
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

test('provider administration methods own their REST paths', async () => {
  await getAdminProviderDistribution();
  await setAdminProviderFallback(true);

  expect(calls.map((call) => call.url)).toEqual([
    'http://test.local/admin/api/provider-distribution',
    'http://test.local/admin/api/provider-fallback',
  ]);
});
