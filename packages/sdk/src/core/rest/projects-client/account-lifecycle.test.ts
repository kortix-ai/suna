import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  cancelAccountDeletion,
  deleteAccountImmediately,
  getAccountDeletionStatus,
  requestAccountDeletion,
} from './account-lifecycle';

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
    });
    return new Response(JSON.stringify({ success: true, message: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('account lifecycle methods own their REST paths', async () => {
  await getAccountDeletionStatus();
  await requestAccountDeletion('reason');
  await cancelAccountDeletion();
  await deleteAccountImmediately();

  expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
    ['GET', 'http://test.local/account/deletion-status', undefined],
    ['POST', 'http://test.local/account/request-deletion', { reason: 'reason' }],
    ['POST', 'http://test.local/account/cancel-deletion', undefined],
    ['DELETE', 'http://test.local/account/delete-immediately', undefined],
  ]);
});

// The account hub renders the danger zone for ANY account the viewer can
// delete, not only their primary one. A scoped call names that account
// explicitly; the server resolves and authorizes it (403 for non-members).
test('a scoped call names the account and never changes the default paths', async () => {
  await getAccountDeletionStatus('acc-2');
  await requestAccountDeletion('reason', 'acc-2');
  await cancelAccountDeletion('acc-2');
  await deleteAccountImmediately('acc-2');

  expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
    ['GET', 'http://test.local/account/deletion-status?account_id=acc-2', undefined],
    ['POST', 'http://test.local/account/request-deletion', { reason: 'reason', account_id: 'acc-2' }],
    ['POST', 'http://test.local/account/cancel-deletion', { account_id: 'acc-2' }],
    ['DELETE', 'http://test.local/account/delete-immediately?account_id=acc-2', undefined],
  ]);
});

// The immediate route reports whether the caller's auth identity went with the
// account. A scoped deletion of a team account keeps the caller signed in, so
// hosts must be able to branch on it (missing field = old server = deleted).
test('the immediate result can report identity_deleted', async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ success: true, message: 'Account deleted', identity_deleted: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;

  const result = await deleteAccountImmediately('acc-2');
  expect(result.identity_deleted).toBe(false);
});
