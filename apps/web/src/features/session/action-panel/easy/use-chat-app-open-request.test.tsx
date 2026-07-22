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
import { useChatAppOpenRequest } from './use-chat-app-open-request';

function Probe({
  sessionId,
  calls,
}: {
  sessionId: string;
  calls: Array<[string, string | undefined]>;
}) {
  useChatAppOpenRequest(sessionId, (url, name) => calls.push([url, name]));
  return null;
}

describe('useChatAppOpenRequest', () => {
  test('fires per request, including a repeat click on the same port', async () => {
    useSessionBrowserStore.setState({ appOpenBySession: {} });
    const calls: Array<[string, string | undefined]> = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s1" calls={calls} />);
    });
    await act(async () => {
      useSessionBrowserStore.getState().requestAppOpen('s1', 'http://localhost:3000/', 'Landing');
    });
    expect(calls).toEqual([['http://localhost:3000/', 'Landing']]);
    // A second click on the same chip must re-open it — the payload is
    // identical, so only the nonce distinguishes the two requests.
    await act(async () => {
      useSessionBrowserStore.getState().requestAppOpen('s1', 'http://localhost:3000/', 'Landing');
    });
    expect(calls).toHaveLength(2);
    renderer!.unmount();
  });

  test('a request that predates mount does not replay, but is still consumed', async () => {
    useSessionBrowserStore.setState({
      appOpenBySession: {
        s2: { url: 'http://localhost:8000/', nonce: 1, requestedAt: Date.now() - 60_000 },
      },
    });
    const calls: Array<[string, string | undefined]> = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s2" calls={calls} />);
    });
    expect(calls).toEqual([]);
    expect(useSessionBrowserStore.getState().appOpenBySession['s2']).toBeUndefined();
    renderer!.unmount();
  });

  test('a fresh pre-mount request fires once on mount (mobile drawer case)', async () => {
    useSessionBrowserStore.setState({ appOpenBySession: {} });
    useSessionBrowserStore.getState().requestAppOpen('s3', 'http://localhost:3000/docs');
    const calls: Array<[string, string | undefined]> = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s3" calls={calls} />);
    });
    expect(calls).toEqual([['http://localhost:3000/docs', undefined]]);
    renderer!.unmount();
  });

  test('requests for other sessions are ignored and left standing', async () => {
    useSessionBrowserStore.setState({ appOpenBySession: {} });
    const calls: Array<[string, string | undefined]> = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s1" calls={calls} />);
    });
    await act(async () => {
      useSessionBrowserStore.getState().requestAppOpen('other', 'http://localhost:3000/');
    });
    expect(calls).toEqual([]);
    expect(useSessionBrowserStore.getState().appOpenBySession['other']).toBeDefined();
    renderer!.unmount();
  });

  test('a delivered request does not replay on remount', async () => {
    useSessionBrowserStore.setState({ appOpenBySession: {} });
    const calls: Array<[string, string | undefined]> = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe sessionId="s5" calls={calls} />);
    });
    await act(async () => {
      useSessionBrowserStore.getState().requestAppOpen('s5', 'http://localhost:3000/');
    });
    expect(calls).toHaveLength(1);

    renderer!.unmount();
    await act(async () => {
      renderer = create(<Probe sessionId="s5" calls={calls} />);
    });
    expect(calls).toHaveLength(1);
    renderer!.unmount();
  });
});
