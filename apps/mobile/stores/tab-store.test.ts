import { beforeEach, describe, expect, test } from 'bun:test';

import { storage } from './in-memory-async-storage';

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

describe('tab store: goBack and goForward restore history entries', () => {
  beforeEach(() => {
    storage.clear();
    resetStore();
  });

  /** ses_1 → page:files → dashboard → ses_2, ending on ses_2. */
  function navigateForward() {
    useTabStore.getState().navigateToSession('ses_1');
    useTabStore.getState().navigateToPage('page:files');
    useTabStore.getState().navigateToSession(null);
    useTabStore.getState().navigateToSession('ses_2');
  }

  test('goBack restores the dashboard, a page, and a session behind the current entry', () => {
    navigateForward();
    expect(useTabStore.getState().openTabOrder).toEqual(['ses_1', 'page:files', 'ses_2']);

    useTabStore.getState().goBack();
    expect(useTabStore.getState().activeSessionId).toBeNull();
    expect(useTabStore.getState().activePageId).toBeNull();
    expect(useTabStore.getState().historyIndex).toBe(2);

    useTabStore.getState().goBack();
    expect(useTabStore.getState().activePageId).toBe('page:files');
    expect(useTabStore.getState().activeSessionId).toBeNull();
    expect(useTabStore.getState().openPageIds).toEqual(['page:files']);
    expect(useTabStore.getState().openTabOrder).toEqual(['ses_1', 'page:files', 'ses_2']);

    useTabStore.getState().goBack();
    expect(useTabStore.getState().activeSessionId).toBe('ses_1');
    expect(useTabStore.getState().activePageId).toBeNull();
    expect(useTabStore.getState().openTabIds).toEqual(['ses_1', 'ses_2']);
    expect(useTabStore.getState().historyIndex).toBe(0);
  });

  test('goForward replays the dashboard, a page, and a session ahead of the current entry', () => {
    navigateForward();
    useTabStore.getState().goBack();
    useTabStore.getState().goBack();
    useTabStore.getState().goBack();
    expect(useTabStore.getState().historyIndex).toBe(0);

    useTabStore.getState().goForward();
    expect(useTabStore.getState().activeSessionId).toBeNull();
    expect(useTabStore.getState().activePageId).toBe('page:files');
    expect(useTabStore.getState().openPageIds).toEqual(['page:files']);
    expect(useTabStore.getState().historyIndex).toBe(1);

    useTabStore.getState().goForward();
    expect(useTabStore.getState().activeSessionId).toBeNull();
    expect(useTabStore.getState().activePageId).toBeNull();
    expect(useTabStore.getState().historyIndex).toBe(2);

    useTabStore.getState().goForward();
    expect(useTabStore.getState().activeSessionId).toBe('ses_2');
    expect(useTabStore.getState().activePageId).toBeNull();
    expect(useTabStore.getState().openTabIds).toEqual(['ses_1', 'ses_2']);
    expect(useTabStore.getState().historyIndex).toBe(3);
  });

  test('goBack and goForward at the edges do not change state', () => {
    useTabStore.getState().goForward();
    expect(useTabStore.getState().historyIndex).toBe(-1);
    expect(useTabStore.getState().sessionHistory).toEqual([]);
    expect(useTabStore.getState().activeSessionId).toBeNull();

    useTabStore.getState().goBack();
    expect(useTabStore.getState().historyIndex).toBe(-1);

    useTabStore.getState().navigateToSession('ses_1');
    expect(useTabStore.getState().historyIndex).toBe(0);

    useTabStore.getState().goBack();
    expect(useTabStore.getState().historyIndex).toBe(0);
    expect(useTabStore.getState().activeSessionId).toBe('ses_1');

    useTabStore.getState().goForward();
    expect(useTabStore.getState().historyIndex).toBe(0);
  });

  test('navigating back or forward to a closed tab reopens it at the end of the open order', () => {
    navigateForward();
    useTabStore.getState().closeTab('page:files');
    useTabStore.getState().closeTab('ses_1');
    expect(useTabStore.getState().openTabOrder).toEqual(['ses_2']);

    useTabStore.getState().goBack();
    expect(useTabStore.getState().activeSessionId).toBeNull();
    expect(useTabStore.getState().activePageId).toBeNull();

    useTabStore.getState().goBack();
    expect(useTabStore.getState().activePageId).toBe('page:files');
    expect(useTabStore.getState().openPageIds).toEqual(['page:files']);
    expect(useTabStore.getState().openTabOrder).toEqual(['ses_2', 'page:files']);

    useTabStore.getState().goBack();
    expect(useTabStore.getState().activeSessionId).toBe('ses_1');
    expect(useTabStore.getState().openTabIds).toEqual(['ses_2', 'ses_1']);
    expect(useTabStore.getState().openTabOrder).toEqual(['ses_2', 'page:files', 'ses_1']);

    useTabStore.getState().goForward();
    useTabStore.getState().goForward();
    useTabStore.getState().goForward();
    expect(useTabStore.getState().activeSessionId).toBe('ses_2');
    expect(useTabStore.getState().openTabIds).toEqual(['ses_2', 'ses_1']);
    expect(useTabStore.getState().openTabOrder).toEqual(['ses_2', 'page:files', 'ses_1']);
  });

  test('a missing history entry aborts the navigation without moving the index', () => {
    // A history hole is unreachable through the public API; setState builds one
    // to pin the defensive `!entry` abort in both directions.
    const withHoleAhead = new Array<string>(2);
    withHoleAhead[0] = 'ses_1';
    useTabStore.setState({
      sessionHistory: withHoleAhead,
      historyIndex: 0,
      activeSessionId: 'ses_1',
    });

    useTabStore.getState().goForward();
    expect(useTabStore.getState().historyIndex).toBe(0);
    expect(useTabStore.getState().activeSessionId).toBe('ses_1');

    const withHoleBehind = new Array<string>(2);
    withHoleBehind[1] = 'ses_2';
    useTabStore.setState({
      sessionHistory: withHoleBehind,
      historyIndex: 1,
      activeSessionId: 'ses_2',
    });

    useTabStore.getState().goBack();
    expect(useTabStore.getState().historyIndex).toBe(1);
    expect(useTabStore.getState().activeSessionId).toBe('ses_2');
  });
});

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
