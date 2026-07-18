import { describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  };
}

import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { useChatFileOpenRequest } from './use-chat-file-open-request';

function Probe({ sessionId, calls }: { sessionId: string; calls: string[] }) {
  useChatFileOpenRequest(sessionId, (path) => calls.push(path));
  return null;
}

describe('useChatFileOpenRequest', () => {
  test('fires per request, including a repeat click on the same path', async () => {
    useSessionBrowserStore.setState({ fileOpenBySession: {} });
    const calls: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s1" calls={calls} />);
    });
    await act(async () => {
      useSessionBrowserStore.getState().requestFileOpen('s1', '/workspace/a.txt');
    });
    expect(calls).toEqual(['/workspace/a.txt']);
    await act(async () => {
      useSessionBrowserStore.getState().requestFileOpen('s1', '/workspace/a.txt');
    });
    expect(calls).toEqual(['/workspace/a.txt', '/workspace/a.txt']);
    renderer!.unmount();
  });

  test('a request that predates mount does not replay', async () => {
    useSessionBrowserStore.setState({
      fileOpenBySession: {
        s2: { path: '/workspace/stale.txt', nonce: 1, requestedAt: Date.now() - 60_000 },
      },
    });
    const calls: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s2" calls={calls} />);
    });
    expect(calls).toEqual([]);
    // The stale entry was still observed on mount, so it must be consumed
    // (removed from the store) even though it was too old to fire.
    expect(useSessionBrowserStore.getState().fileOpenBySession['s2']).toBeUndefined();
    await act(async () => {
      useSessionBrowserStore.getState().requestFileOpen('s2', '/workspace/fresh.txt');
    });
    expect(calls).toEqual(['/workspace/fresh.txt']);
    renderer!.unmount();
  });

  test('a fresh pre-mount request fires once on mount (mobile drawer case)', async () => {
    useSessionBrowserStore.setState({ fileOpenBySession: {} });
    useSessionBrowserStore.getState().requestFileOpen('s4', '/workspace/fresh-mount.txt');
    const calls: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s4" calls={calls} />);
    });
    expect(calls).toEqual(['/workspace/fresh-mount.txt']);
    await act(async () => {
      useSessionBrowserStore.getState().requestFileOpen('s4', '/workspace/again.txt');
    });
    expect(calls).toEqual(['/workspace/fresh-mount.txt', '/workspace/again.txt']);
    renderer!.unmount();
  });

  test('requests for other sessions are ignored', async () => {
    useSessionBrowserStore.setState({ fileOpenBySession: {} });
    const calls: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s1" calls={calls} />);
    });
    await act(async () => {
      useSessionBrowserStore.getState().requestFileOpen('other', '/workspace/x.txt');
    });
    expect(calls).toEqual([]);
    // Never observed by this hook (it only watches 's1'), so it must still
    // be sitting in the store for whatever consumer eventually mounts for
    // 'other' — this hook must not have swallowed it.
    expect(useSessionBrowserStore.getState().fileOpenBySession['other']).toBeDefined();
    renderer!.unmount();
  });

  test('a delivered request does not replay on remount', async () => {
    useSessionBrowserStore.setState({ fileOpenBySession: {} });
    const calls: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s5" calls={calls} />);
    });
    await act(async () => {
      useSessionBrowserStore.getState().requestFileOpen('s5', '/workspace/once.txt');
    });
    expect(calls).toEqual(['/workspace/once.txt']);
    expect(useSessionBrowserStore.getState().fileOpenBySession['s5']).toBeUndefined();

    renderer!.unmount();

    // Remount immediately (well within the freshness window) — the request
    // was already consumed, so the new mount must not re-fire it.
    await act(async () => {
      renderer = create(<Probe sessionId="s5" calls={calls} />);
    });
    expect(calls).toEqual(['/workspace/once.txt']);
    renderer!.unmount();
  });
});
