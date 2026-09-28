import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';
import { useSyncStore } from '../browser/stores/sync-store';
import type { KeyValueStorage } from '../core/cache/persisted-query-cache';
import { configureKortix } from '../core/http/config';
import type { SessionTranscriptSyncEnvelope } from '../core/rest/projects-client/sessions';
import { SAVED_COPY_REFRESH_DELAY_MS } from '../browser/session-sync/server-transcript-mirror';
import { resetSessionOpenBundles } from '../core/session/open-bundle';
import {
  type SavedCopyStore,
  createSavedCopyStore,
  setSavedCopyStore,
} from '../core/session-sync/saved-copy-store';
import { useSessionSync } from './use-session-sync';

/**
 * The saved copy the server sent at the LAST open is kept on the device, so
 * the next open paints it in the first frame instead of skeleton rows. The
 * copy from the network then reconciles into it by message id, for as long as
 * no runtime read has landed. These tests pin that order and its guards.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
const touched: string[] = [];

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  resetSessionOpenBundles();
  setSavedCopyStore(null);
  for (const id of touched.splice(0)) useSyncStore.getState().clearSession(id);
});

const PROJECT = 'p1';
const SESSION = '2f6c0a52-7d0e-4b8e-9f51-3c5b8d7e0a11';
const SCOPE = `${PROJECT}/${SESSION}`;

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function message(rootId: string, n: number) {
  return {
    info: { id: `msg_${rootId}_${n}`, sessionID: rootId, role: 'assistant', time: { created: n, completed: n + 1 } },
    parts: [{ id: `prt_${rootId}_${n}`, type: 'text', text: `Reply ${n}` }],
  };
}

function envelope(rootId: string, count: number, capturedAt = '2026-09-25T00:00:00Z'): SessionTranscriptSyncEnvelope {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: capturedAt,
    opencode_session_id: rootId,
    message_count: count,
    messages: Array.from({ length: count }, (_, i) => message(rootId, i + 1)),
  } as unknown as SessionTranscriptSyncEnvelope;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

type Options = NonNullable<Parameters<typeof useSessionSync>[1]>;

async function mount(sessionId: string, options: Options) {
  touched.push(sessionId);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  let value!: ReturnType<typeof useSessionSync>;
  function Probe() {
    value = useSessionSync(sessionId, options);
    return null;
  }
  await act(async () => {
    root = create(React.createElement(Probe));
  });
  return { value: () => value };
}

const offline: Options = { kortixSessionScope: SCOPE, networkEnabled: false };

function heldFetch() {
  let answer!: (response: Response) => void;
  globalThis.fetch = mock(
    async () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  ) as unknown as typeof fetch;
  return (response: Response) => answer(response);
}

async function seeded(rootId: string, count: number): Promise<SavedCopyStore & { storage: ReturnType<typeof memoryStorage> }> {
  const storage = memoryStorage();
  const store = createSavedCopyStore({ storage, userId: 'user-a' });
  await store.write(PROJECT, SESSION, envelope(rootId, count));
  setSavedCopyStore(store);
  return Object.assign(store, { storage });
}

test('the local copy paints in the first frame, before the server answers', async () => {
  await seeded('ses_local_first', 2);
  heldFetch();

  const hook = await mount('ses_local_first', offline);

  expect(hook.value().messages).toHaveLength(2);
  expect(hook.value().mirrorState).toBe('painted');
});

test("the server's newer copy reconciles into the local one and is kept for the next open", async () => {
  const store = await seeded('ses_local_merge', 2);
  const answer = heldFetch();
  const hook = await mount('ses_local_merge', offline);
  expect(hook.value().messages).toHaveLength(2);

  await act(async () => {
    answer(Response.json(envelope('ses_local_merge', 3, '2026-09-26T00:00:00Z')));
  });
  await settle();

  expect(hook.value().messages).toHaveLength(3);
  const kept = store.read(PROJECT, SESSION) as SessionTranscriptSyncEnvelope;
  expect(kept.messages).toHaveLength(3);
});

test('a local copy captured from another root is refused', async () => {
  await seeded('ses_old_root', 2);
  heldFetch();

  const hook = await mount('ses_new_root', offline);

  expect(hook.value().messages).toHaveLength(0);
  expect(hook.value().mirrorState).toBe('loading');
});

test('a failed read keeps the local copy for the next open', async () => {
  const store = await seeded('ses_local_offline', 2);
  globalThis.fetch = mock(async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;

  const hook = await mount('ses_local_offline', offline);
  await settle();

  expect(hook.value().messages).toHaveLength(2);
  expect(store.read(PROJECT, SESSION)).not.toBeNull();
});

test('a server that no longer holds a copy removes the local one', async () => {
  const store = await seeded('ses_local_gone', 2);
  const answer = heldFetch();
  await mount('ses_local_gone', offline);

  await act(async () => {
    answer(
      Response.json({
        ...envelope('ses_local_gone', 0),
        available: false,
        source: 'none',
      }),
    );
  });
  await settle();

  expect(store.read(PROJECT, SESSION)).toBeNull();
});

test('without a configured store nothing is read or written locally', async () => {
  const answer = heldFetch();
  const hook = await mount('ses_no_store', offline);
  expect(hook.value().mirrorState).toBe('loading');

  await act(async () => {
    answer(Response.json(envelope('ses_no_store', 1)));
  });
  await settle();

  expect(hook.value().messages).toHaveLength(1);
});

test('when a turn ends, the kept copy is re-read from the server', async () => {
  const store = await seeded('ses_turn_end', 1);
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json(envelope('ses_turn_end', 4, '2026-09-26T01:00:00Z'));
  }) as unknown as typeof fetch;
  const scheduled: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    if (ms === SAVED_COPY_REFRESH_DELAY_MS) {
      scheduled.push(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(callback, ms);
  }) as typeof setTimeout;
  try {
    let working = true;
    touched.push('ses_turn_end');
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    function Probe() {
      useSessionSync('ses_turn_end', { ...offline, working });
      return null;
    }
    await act(async () => {
      root = create(React.createElement(Probe));
    });
    await settle();
    const before = requests.length;
    expect(scheduled).toHaveLength(0);

    working = false;
    await act(async () => {
      root?.update(React.createElement(Probe));
    });
    expect(scheduled).toHaveLength(1);

    await act(async () => {
      scheduled[0]();
      await new Promise((resolve) => realSetTimeout(resolve, 20));
    });
    expect(requests.length).toBe(before + 1);
    expect(requests.at(-1)).toContain('/transcript?shape=sync');
    expect((store.read(PROJECT, SESSION) as SessionTranscriptSyncEnvelope).messages).toHaveLength(4);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
