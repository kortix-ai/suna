import { beforeEach, describe, expect, mock, test } from 'bun:test';

// In-memory AsyncStorage: the tab store persists through it. The tool preview
// store does not persist, but importing it must not touch the missing module.
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
const { useToolPreviewStore } = await import('./tool-preview-store');

const PREVIEW_URL = 'https://api.example.test/p/sbx_1/3000/';

/**
 * The reported KRTX-602 defect: tapping a Show tool's localhost preview opened
 * the Browser page tab, which replaces the session (`tab-store`
 * `navigateToPage` clears `activeSessionId`). The reader lost their place and
 * had to reopen the session. A preview now opens the in-session sheet; this
 * pins the invariant that opening and closing it never moves the session.
 */
describe('a tool preview opens in-session (KRTX-602)', () => {
  beforeEach(() => {
    storage.clear();
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
    useToolPreviewStore.setState({ url: null, label: '' });
  });

  test('opening a preview does not navigate away from the session', () => {
    useTabStore.getState().navigateToSession('ses_1');

    useToolPreviewStore.getState().openPreview(PREVIEW_URL, 'App preview');

    expect(useToolPreviewStore.getState().url).toBe(PREVIEW_URL);
    expect(useToolPreviewStore.getState().label).toBe('App preview');
    expect(useTabStore.getState().activeSessionId).toBe('ses_1');
    expect(useTabStore.getState().activePageId).toBeNull();
    expect(useTabStore.getState().openPageIds).toEqual([]);
  });

  test('closing the preview leaves the session active and its scroll untouched', () => {
    useTabStore.getState().navigateToSession('ses_1');
    useTabStore.getState().setTabState('ses_1', { scrollOffset: 480 });

    useToolPreviewStore.getState().openPreview(PREVIEW_URL);
    useToolPreviewStore.getState().closePreview();

    expect(useToolPreviewStore.getState().url).toBeNull();
    expect(useTabStore.getState().activeSessionId).toBe('ses_1');
    expect(useTabStore.getState().tabStateById.ses_1).toEqual({ scrollOffset: 480 });
  });

  test('a second preview swaps the URL', () => {
    useToolPreviewStore.getState().openPreview(PREVIEW_URL, 'First');
    useToolPreviewStore.getState().openPreview('https://api.example.test/p/sbx_1/5173/', 'Second');

    expect(useToolPreviewStore.getState().url).toBe('https://api.example.test/p/sbx_1/5173/');
    expect(useToolPreviewStore.getState().label).toBe('Second');
  });
});
