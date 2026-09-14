import { beforeEach, expect, mock, test } from 'bun:test';
import { useSyncStore } from '../../browser/stores/sync-store';
import { opencodeKeys } from './keys';

let read: () => Promise<unknown>;
mock.module('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => options,
  useMutation: (options: unknown) => options,
  useQueryClient: () => ({ getQueryData: () => undefined }),
}));
mock.module('./keys', () => ({ opencodeKeys, useOpenCodeRuntimeReady: () => true }));
mock.module('../../core/runtime/client', () => ({ getClient: () => ({ session: { get: () => read() } }) }));
const { useOpenCodeSession } = await import('./sessions');
const query = () => (useOpenCodeSession('ses_read') as unknown as { queryFn: () => Promise<unknown> }).queryFn();
beforeEach(() => { useSyncStore.getState().reset(); });

test('an initial session read restores the saved rewind without an SSE staging event', async () => {
  read = async () => ({ data: { id: 'ses_read', revert: { messageID: 'msg_saved' } } });
  await query();
  expect(useSyncStore.getState().sessionRevert.ses_read).toMatchObject({ staged: true, messageId: 'msg_saved' });
});

test('a session read cannot hydrate another runtime identity', async () => {
  read = async () => ({ data: { id: 'ses_foreign', revert: { messageID: 'msg_saved' } } });
  await query();
  expect(useSyncStore.getState().sessionRevert).toEqual({});
});

test('a stale session read does not resurrect a rewind committed while it was in flight', async () => {
  read = async () => {
    useSyncStore.getState().stageSessionRevert('ses_read', 'msg_saved');
    useSyncStore.getState().commitSessionRevert('ses_read');
    return { data: { id: 'ses_read', revert: { messageID: 'msg_saved' } } };
  };
  await query();
  expect(useSyncStore.getState().sessionRevert.ses_read?.staged).not.toBe(true);
});

test('a delayed session read cannot replace a newer staging event', async () => {
  read = async () => {
    useSyncStore.getState().stageSessionRevert('ses_read', 'msg_newer');
    return { data: { id: 'ses_read', revert: { messageID: 'msg_older' } } };
  };
  await query();
  expect(useSyncStore.getState().sessionRevert.ses_read).toMatchObject({ staged: true, messageId: 'msg_newer' });
});
