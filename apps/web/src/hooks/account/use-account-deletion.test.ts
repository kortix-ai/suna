import { beforeEach, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const deleted = { success: true, message: 'Deleted' };
const scheduled = { success: true, message: 'Scheduled', deletion_scheduled_for: '2030-01-01', can_cancel: true };
const deleteAccountImmediately = mock(async () => deleted);
const requestAccountDeletion = mock(async (_reason?: string) => scheduled);
const cancelAccountDeletion = mock(async () => ({ success: true, message: 'Cancelled' }));
const performSignOut = mock(async () => {});
const successToast = mock((_message: string) => {});
const errorToast = mock((_message: string) => {});
mock.module('@kortix/sdk', () => ({ deleteAccountImmediately, requestAccountDeletion, cancelAccountDeletion, getAccountDeletionStatus: mock() }));
mock.module('@/lib/auth/perform-sign-out', () => ({ performSignOut }));
mock.module('@/components/ui/toast', () => ({ successToast, errorToast }));
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => ({ raw: (key: string) => key }) }));
const { useDeleteAccountImmediately, useRequestAccountDeletion, useCancelAccountDeletion, ACCOUNT_DELETION_QUERY_KEY } = await import('./use-account-deletion');

beforeEach(() => {
  deleteAccountImmediately.mockReset().mockResolvedValue(deleted);
  requestAccountDeletion.mockClear();
  cancelAccountDeletion.mockClear();
  performSignOut.mockReset().mockResolvedValue();
  successToast.mockClear();
  errorToast.mockClear();
});

async function mount<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const holder: { current?: T } = {};
  function Probe() { holder.current = hook(); return null; }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(QueryClientProvider, { client }, createElement(Probe))); });
  if (!holder.current) throw new Error('Hook did not mount');
  return { mutation: holder.current, client, close: async () => { await act(async () => renderer?.unmount()); client.clear(); } };
}

test('immediate deletion awaits shared sign-out without rewriting deletion cache', async () => {
  let finish = () => {};
  performSignOut.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const mounted = await mount(useDeleteAccountImmediately);
  const previous = { has_pending_deletion: true };
  mounted.client.setQueryData(ACCOUNT_DELETION_QUERY_KEY, previous);
  let settled = false;
  const pending = mounted.mutation.mutateAsync().then(() => { settled = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deleteAccountImmediately).toHaveBeenCalledTimes(1);
    expect(successToast).toHaveBeenCalledWith('Deleted');
    expect(performSignOut).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(mounted.client.getQueryData(ACCOUNT_DELETION_QUERY_KEY)).toEqual(previous);
  } finally { finish(); await pending; await mounted.close(); }
});

test('deletion failure reports the error and never signs out', async () => {
  deleteAccountImmediately.mockRejectedValue(new Error('Deletion failed'));
  const mounted = await mount(useDeleteAccountImmediately);
  try {
    await expect(mounted.mutation.mutateAsync()).rejects.toThrow('Deletion failed');
    expect(errorToast).toHaveBeenCalledWith('Deletion failed');
    expect(successToast).not.toHaveBeenCalled();
    expect(performSignOut).not.toHaveBeenCalled();
  } finally { await mounted.close(); }
});

test('sign-out rejection propagates through the mutation error handler', async () => {
  performSignOut.mockRejectedValue(new Error('Sign-out failed'));
  const mounted = await mount(useDeleteAccountImmediately);
  try {
    await expect(mounted.mutation.mutateAsync()).rejects.toThrow('Sign-out failed');
    expect(errorToast).toHaveBeenCalledWith('Sign-out failed');
  } finally { await mounted.close(); }
});

test('scheduled deletion and cancellation still update status without sign-out', async () => {
  const request = await mount(useRequestAccountDeletion);
  const cancel = await mount(useCancelAccountDeletion);
  try {
    await request.mutation.mutateAsync('Synthetic reason');
    expect(requestAccountDeletion).toHaveBeenCalledWith('Synthetic reason');
    expect(request.client.getQueryData(ACCOUNT_DELETION_QUERY_KEY)).toEqual({ has_pending_deletion: true, deletion_scheduled_for: '2030-01-01', requested_at: expect.any(String), can_cancel: true, supported: true });
    await cancel.mutation.mutateAsync();
    expect(cancelAccountDeletion).toHaveBeenCalledTimes(1);
    expect(cancel.client.getQueryData(ACCOUNT_DELETION_QUERY_KEY)).toEqual({ has_pending_deletion: false, deletion_scheduled_for: null, requested_at: null, can_cancel: false, supported: true });
    expect(successToast).toHaveBeenCalledWith('Scheduled');
    expect(successToast).toHaveBeenCalledWith('Cancelled');
    expect(performSignOut).not.toHaveBeenCalled();
  } finally { await request.close(); await cancel.close(); }
});
