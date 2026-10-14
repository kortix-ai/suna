import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { configureKortix } from '@kortix/sdk';
import { resetIdentityState } from '@kortix/sdk/react';
import { useSavedCopy, type SavedCopyTarget } from './useSavedCopy';

/**
 * The connecting view shows a session's saved copy while its computer wakes
 * (up to minutes). The copy is read by `@kortix/sdk` with the web's one
 * saved-history read (KRTX-189); these tests pin what this app paints from it
 * and the requests it costs.
 */

const ROOT = 'ses_mobile_root';
const CHILD = 'ses_mobile_child';
const originalFetch = globalThis.fetch;

let urls: string[] = [];
function serve(route: (url: string) => unknown) {
  urls = [];
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    return Response.json(route(url));
  }) as unknown as typeof fetch;
}

function copy(rootId: string, count: number, fields: Record<string, unknown> = {}) {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: '2026-09-26T10:00:00Z',
    opencode_session_id: rootId,
    message_count: count,
    messages: Array.from({ length: count }, (_, i) => ({
      info: { id: `msg_${rootId}_${i + 1}`, sessionID: rootId, role: 'assistant', time: { created: i + 1, completed: i + 2 } },
      parts: [{ id: `prt_${rootId}_${i + 1}`, type: 'text', text: `message ${i + 1}` }],
    })),
    ...fields,
  };
}

const target = (fields: Partial<SavedCopyTarget> = {}): SavedCopyTarget => ({
  projectId: 'p1',
  sessionId: 's1',
  rootId: ROOT,
  child: false,
  ...fields,
});

let tree: any;
let latest: ReturnType<typeof useSavedCopy> | null = null;
function Probe(props: { target: SavedCopyTarget | null }) {
  latest = useSavedCopy(props.target);
  return null;
}

async function mount(value: SavedCopyTarget | null) {
  await act(async () => {
    tree = create(React.createElement(Probe, { target: value }));
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  return latest!;
}

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
});

afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
  latest = null;
  globalThis.fetch = originalFetch;
  resetIdentityState();
});

describe('useSavedCopy', () => {
  test('the root paints the server copy from one saved-history read', async () => {
    serve(() => copy(ROOT, 2));
    const view = await mount(target());
    expect(view.messages?.map((message) => message.info.id)).toEqual([`msg_${ROOT}_1`, `msg_${ROOT}_2`]);
    expect(view.empty).toBe(false);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/projects/p1/sessions/s1/transcript?shape=sync');
    expect(urls[0]).toContain('history=true');
  });

  test('a sub-agent paints its own window, read by `child`, and never claims emptiness', async () => {
    serve(() => copy(CHILD, 1));
    const view = await mount(target({ rootId: CHILD, child: true }));
    expect(view.messages?.map((message) => message.info.sessionID)).toEqual([CHILD]);
    expect(view.empty).toBe(false);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`child=${CHILD}`);
  });

  test('a copy that proves the root empty, with no turn on record, opens on the composer', async () => {
    serve((url) => (url.includes('/turn') ? { turns: [] } : copy(ROOT, 0, { total: 0 })));
    const view = await mount(target());
    expect(view.empty).toBe(true);
    expect(view.messages).toBeUndefined();
  });

  test('a failed read paints nothing and claims nothing', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const view = await mount(target());
    expect(view).toEqual({ messages: undefined, empty: false });
  });

  test('no target reads nothing', async () => {
    serve(() => copy(ROOT, 2));
    const view = await mount(null);
    expect(view).toEqual({ messages: undefined, empty: false });
    expect(urls).toHaveLength(0);
  });
});
