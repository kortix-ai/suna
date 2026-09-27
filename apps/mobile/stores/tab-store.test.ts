import { beforeEach, describe, expect, mock, test } from 'bun:test';

// In-memory AsyncStorage: the tab store persists through it.
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

const { useTabStore } = await import('./tab-store');

const STORAGE_KEY = 'kortix-tab-state';
const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

function resetStore() {
  useTabStore.setState({
    activeSessionId: null,
    activePageId: null,
    openTabIds: [],
    openPageIds: [],
    openTabOrder: [],
    sessionHistory: [],
    historyIndex: -1,
    tabStateById: {},
    scopeKey: null,
    scopes: {},
  });
}

describe('tab store: a project always opens on its home', () => {
  beforeEach(() => {
    storage.clear();
    resetStore();
  });

  test('reopening the same project drops the open page and thread but keeps its tabs', () => {
    useTabStore.getState().setScope(PROJECT_A);
    useTabStore.getState().navigateToSession('ses_1');
    useTabStore.getState().navigateToPage('page:files');
    expect(useTabStore.getState().activePageId).toBe('page:files');

    useTabStore.getState().setScope(PROJECT_A);

    const state = useTabStore.getState();
    expect(state.activePageId).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(state.openTabIds).toEqual(['ses_1']);
    expect(state.openPageIds).toEqual(['page:files']);
  });

  test('switching projects opens each project on its home with its own tabs', () => {
    useTabStore.getState().setScope(PROJECT_A);
    useTabStore.getState().navigateToPage('page:agents');

    useTabStore.getState().setScope(PROJECT_B);
    expect(useTabStore.getState().activePageId).toBeNull();
    expect(useTabStore.getState().openPageIds).toEqual([]);
    useTabStore.getState().navigateToSession('ses_b');

    useTabStore.getState().setScope(PROJECT_A);
    expect(useTabStore.getState().activePageId).toBeNull();
    expect(useTabStore.getState().activeSessionId).toBeNull();
    expect(useTabStore.getState().openPageIds).toEqual(['page:agents']);

    useTabStore.getState().setScope(PROJECT_B);
    expect(useTabStore.getState().activeSessionId).toBeNull();
    expect(useTabStore.getState().openTabIds).toEqual(['ses_b']);
  });

  test('the first scope adopts tabs from before scoping but not the active page', () => {
    useTabStore.setState({ openPageIds: ['page:memory'], activePageId: 'page:memory' });

    useTabStore.getState().setScope(PROJECT_A);

    expect(useTabStore.getState().activePageId).toBeNull();
    expect(useTabStore.getState().openPageIds).toEqual(['page:memory']);
  });

  test('persisted state holds open tabs but no active page or thread', () => {
    useTabStore.getState().setScope(PROJECT_A);
    useTabStore.getState().navigateToSession('ses_1');
    useTabStore.getState().navigateToPage('page:files');

    const persisted = JSON.parse(storage.get(STORAGE_KEY) ?? '{}').state;
    expect(persisted).not.toHaveProperty('activePageId');
    expect(persisted).not.toHaveProperty('activeSessionId');
    expect(persisted.openPageIds).toEqual(['page:files']);
    expect(persisted.openTabIds).toEqual(['ses_1']);
  });

  test('storage written by older builds rehydrates without its active page or thread', async () => {
    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          activeSessionId: 'ses_1',
          activePageId: 'page:files',
          openTabIds: ['ses_1'],
          openPageIds: ['page:files'],
          openTabOrder: ['ses_1', 'page:files'],
          sessionHistory: ['ses_1', 'page:files'],
          historyIndex: 1,
          tabStateById: {},
          scopeKey: PROJECT_A,
          scopes: {},
        },
        version: 0,
      })
    );

    await useTabStore.persist.rehydrate();

    const state = useTabStore.getState();
    expect(state.activePageId).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(state.openPageIds).toEqual(['page:files']);
    expect(state.scopeKey).toBe(PROJECT_A);
  });
});
