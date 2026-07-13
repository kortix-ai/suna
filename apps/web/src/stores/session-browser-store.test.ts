import { beforeEach, describe, expect, it } from 'bun:test';
import { useSessionBrowserStore } from './session-browser-store';

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
