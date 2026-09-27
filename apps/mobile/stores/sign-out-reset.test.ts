import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The tab store is not imported here. Bun shares one module registry across
// test files, and the persist middleware keeps the storage object it was
// created with, so importing it under this mock breaks tab-store.test.ts.

// In-memory AsyncStorage: the persisted stores write through it.
const storage = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));

let uuid = 0;
mock.module('expo-crypto', () => ({ randomUUID: () => `uuid-${++uuid}` }));

const deletedFiles: string[] = [];
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  getInfoAsync: async () => ({ exists: true }),
  makeDirectoryAsync: async () => {},
  copyAsync: async () => {},
  deleteAsync: async (uri: string) => {
    deletedFiles.push(uri);
  },
}));

const { useCurrentAccountStore } = await import('./current-account-store');
const { useLastProjectStore } = await import('./last-project-store');
const { useSelectedProjectStore } = await import('./selected-project-store');
const { useMessageQueueStore } = await import('./message-queue-store');
const { useTabScreenshotStore } = await import('./tab-screenshot-store');
const { useComposerDraftStore, scheduleComposerDraftWrite } = await import('./composer-draft-store');

describe('sign-out resets the in-memory account stores', () => {
  beforeEach(() => {
    storage.clear();
    deletedFiles.length = 0;
  });

  test('current account: the selected account is cleared', () => {
    useCurrentAccountStore.getState().setSelectedAccountId('acc_1');
    useCurrentAccountStore.getState().reset();
    expect(useCurrentAccountStore.getState().selectedAccountId).toBeNull();
  });

  test('last project: no user keeps a remembered project', () => {
    useLastProjectStore.getState().remember('user_a', 'project_a');
    useLastProjectStore.getState().reset();
    expect(useLastProjectStore.getState().byUser).toEqual({});
  });

  test('selected project: the project choice is cleared', () => {
    useSelectedProjectStore.getState().setProjectId('project_a');
    useSelectedProjectStore.getState().reset();
    expect(useSelectedProjectStore.getState().projectId).toBeNull();
  });

  test('message queue: queued messages are dropped and the queue stays usable', () => {
    useMessageQueueStore.setState({ hydrated: true });
    useMessageQueueStore.getState().enqueue('ses_1', 'draft for user A');
    expect(useMessageQueueStore.getState().messages).toHaveLength(1);

    useMessageQueueStore.getState().reset();

    expect(useMessageQueueStore.getState().messages).toEqual([]);
    expect(useMessageQueueStore.getState().hydrated).toBe(true);
    useMessageQueueStore.getState().enqueue('ses_2', 'user B');
    expect(useMessageQueueStore.getState().messages.map((m) => m.text)).toEqual(['user B']);
  });

  test('composer drafts: typed drafts and pending writes are dropped', async () => {
    useComposerDraftStore.getState().write('session:ses_1', 'draft for user A');
    scheduleComposerDraftWrite('project:p_1', 'pending for user A');
    useComposerDraftStore.getState().reset();
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    // The debounced write must not land after the reset.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(useComposerDraftStore.getState().drafts).toEqual({});
  });

  test('tab screenshots: the mapping is cleared and the image files are deleted', async () => {
    useTabScreenshotStore.setState({ screenshots: { ses_1: 'file:///docs/tab-screenshots/ses_1.jpg' } });
    useTabScreenshotStore.getState().clear();
    expect(useTabScreenshotStore.getState().screenshots).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deletedFiles).toEqual(['file:///docs/tab-screenshots/ses_1.jpg']);
  });
});
