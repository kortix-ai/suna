import { beforeEach, describe, expect, it } from 'bun:test';
import {
  normalizeSessionPanelLayoutView,
  openFileInSessionPanel,
  useSessionBrowserStore,
} from './session-browser-store';
import { useUserPreferencesStore } from './user-preferences-store';

describe('normalizeSessionPanelLayoutView', () => {
  it('returns users with the removed persisted Voice view to Actions', () => {
    expect(normalizeSessionPanelLayoutView('voice')).toBe('actions');
  });

  it('maps the explorer Changes mode to the Files tab', () => {
    expect(normalizeSessionPanelLayoutView('files')).toBe('explorer');
  });

  it('preserves current panel views', () => {
    expect(normalizeSessionPanelLayoutView('browser')).toBe('browser');
    expect(normalizeSessionPanelLayoutView('explorer')).toBe('explorer');
    expect(normalizeSessionPanelLayoutView('terminal')).toBe('terminal');
    expect(normalizeSessionPanelLayoutView('audit')).toBe('audit');
    expect(normalizeSessionPanelLayoutView('actions')).toBe('actions');
  });
});

describe('requestFileOpen vs requestFileOpenSilently', () => {
  beforeEach(() => {
    useSessionBrowserStore.setState({
      viewBySession: {},
      fileOpenBySession: {},
    });
  });

  it('requestFileOpen flips the session view to explorer', () => {
    useSessionBrowserStore.getState().requestFileOpen('s1', '/a/report.md');
    expect(useSessionBrowserStore.getState().viewBySession.s1).toBe('explorer');
    expect(useSessionBrowserStore.getState().fileOpenBySession.s1?.path).toBe('/a/report.md');
  });

  // ─── Easy mode's own file drill-in must NOT rewrite `viewBySession` — doing
  // so would silently overwrite whatever view Advanced mode had last shown,
  // breaking session-layout.tsx's invariant that Easy mode leaves
  // `viewBySession` untouched so Advanced resumes right where the user left
  // off (see easy-panel.tsx's handleOpenOutput). ────────────────────────────

  it('requestFileOpenSilently sets the file-open request WITHOUT touching viewBySession', () => {
    useSessionBrowserStore.setState({
      viewBySession: { s1: 'browser' },
      fileOpenBySession: {},
    });

    useSessionBrowserStore.getState().requestFileOpenSilently('s1', '/a/report.md');

    expect(useSessionBrowserStore.getState().viewBySession.s1).toBe('browser');
    expect(useSessionBrowserStore.getState().fileOpenBySession.s1?.path).toBe('/a/report.md');
  });

  it('requestFileOpenSilently still increments the nonce on repeated clicks of the same path', () => {
    useSessionBrowserStore.getState().requestFileOpenSilently('s1', '/a/report.md');
    const first = useSessionBrowserStore.getState().fileOpenBySession.s1?.nonce;
    useSessionBrowserStore.getState().requestFileOpenSilently('s1', '/a/report.md');
    const second = useSessionBrowserStore.getState().fileOpenBySession.s1?.nonce;
    expect(second).toBe((first ?? 0) + 1);
  });
});

describe('openFileInSessionPanel mode branch', () => {
  beforeEach(() => {
    useSessionBrowserStore.setState({
      viewBySession: {},
      fileOpenBySession: {},
    });
    useUserPreferencesStore.setState((state) => ({
      preferences: { ...state.preferences, panelMode: 'easy' },
    }));
  });

  // ─── Easy mode consumes fileOpenBySession directly (EasyPanel) and must
  // never write viewBySession — that key is Advanced mode's resume point,
  // and Easy has no tab strip for it to point at. ────────────────────────

  it('in Easy mode, leaves viewBySession untouched and still sets the file-open request', () => {
    useUserPreferencesStore.setState((state) => ({
      preferences: { ...state.preferences, panelMode: 'easy' },
    }));

    openFileInSessionPanel('s1', '/a/report.md');

    expect(useSessionBrowserStore.getState().viewBySession.s1).toBeUndefined();
    expect(useSessionBrowserStore.getState().fileOpenBySession.s1?.path).toBe('/a/report.md');
  });

  // ─── Advanced mode has no fileOpenBySession consumer of its own — it
  // relies on the view flipping to 'explorer' so SessionFilesExplorer mounts
  // and picks up the request. Silently skipping that flip drops the file. ──

  it('in Advanced mode, flips viewBySession to explorer and sets the file-open request', () => {
    useUserPreferencesStore.setState((state) => ({
      preferences: { ...state.preferences, panelMode: 'advanced' },
    }));

    openFileInSessionPanel('s1', '/a/report.md');

    expect(useSessionBrowserStore.getState().viewBySession.s1).toBe('explorer');
    expect(useSessionBrowserStore.getState().fileOpenBySession.s1?.path).toBe('/a/report.md');
  });
});
