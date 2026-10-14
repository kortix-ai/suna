import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { setRuntimeCapabilities } from '../browser/stores/sandbox-connection-store';
import { configureKortix } from '../core/http/config';
import { setCurrentRuntime } from '../core/session/current-runtime';
import { useSession } from './opencode';

/**
 * A host that reads its own transcript (`chatEngine: false`, apps/mobile) still renders the
 * session log: `useSession` negotiates it, so `useSessionLogThread` serves v2 records once the
 * runtime lists `session.log.v2` and the project flag `session_log` is on.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = '00000000-0000-4000-8000-0000000000c1';
const SESSION_ID = 'kses_log_host';

let urls: string[];
let renderer: ReactTestRenderer | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  urls = [];
  setCurrentRuntime(null);
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    urls.push(path);
    if (path === `/projects/${PROJECT_ID}/detail`) return Response.json({ project: { project_id: PROJECT_ID, experimental: { session_log: true } }, config: {} });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  queryClient.clear();
  setRuntimeCapabilities(null);
});

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });

describe('useSession negotiates the session log without its chat engine', () => {
  test.each([true, false])('chatEngine %p: the flag is read and the first log page is requested', async (chatEngine) => {
    function Host() {
      useSession(PROJECT_ID, SESSION_ID, { chatEngine, replayStartStash: false });
      return null;
    }
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    });
    // The runtime's health answer lists the log (a box switch clears the list first).
    act(() => setRuntimeCapabilities(['session.log.v2']));
    await flush();
    expect(urls).toContain(`/projects/${PROJECT_ID}/sessions/${SESSION_ID}/log`);
  });

  test('disabled: no log request', async () => {
    function Host() {
      useSession(PROJECT_ID, SESSION_ID, { enabled: false, chatEngine: false, replayStartStash: false });
      return null;
    }
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    });
    act(() => setRuntimeCapabilities(['session.log.v2']));
    await flush();
    expect(urls.filter((u) => u.endsWith('/log'))).toEqual([]);
  });
});
