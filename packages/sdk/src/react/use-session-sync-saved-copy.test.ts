import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';
import { useSyncStore } from '../browser/stores/sync-store';
import { configureKortix } from '../core/http/config';
import type { SessionTranscriptSyncEnvelope } from '../core/rest/projects-client/sessions';
import { resetSessionOpenBundles } from '../core/session/open-bundle';
import { useSessionSync } from './use-session-sync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
const touched: string[] = [];

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  resetSessionOpenBundles();
  for (const id of touched.splice(0)) useSyncStore.getState().clearSession(id);
});

const SCOPE = 'p1/2f6c0a52-7d0e-4b8e-9f51-3c5b8d7e0a11';

function envelope(
  rootId: string,
  overrides: Partial<SessionTranscriptSyncEnvelope> = {},
): SessionTranscriptSyncEnvelope {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: '2026-09-25T00:00:00Z',
    opencode_session_id: rootId,
    message_count: 1,
    messages: [
      {
        info: {
          id: `msg_${rootId}`,
          sessionID: rootId,
          role: 'assistant',
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: `prt_${rootId}`, type: 'text', text: 'Saved reply' }],
      },
    ],
    ...overrides,
  };
}

type Options = NonNullable<Parameters<typeof useSessionSync>[1]>;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(sessionId: string, options: Options) {
  touched.push(sessionId);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  let value!: ReturnType<typeof useSessionSync>;
  function Probe(props: { sessionId: string; options: Options }) {
    value = useSessionSync(props.sessionId, props.options);
    return null;
  }
  const render = (sid: string, opts: Options) =>
    React.createElement(Probe, { sessionId: sid, options: opts });
  await act(async () => {
    root = create(render(sessionId, options));
  });
  await settle();
  return {
    value: () => value,
    update: async (sid: string, opts: Options) => {
      touched.push(sid);
      await act(async () => {
        root?.update(render(sid, opts));
      });
      await settle();
    },
  };
}

const offline: Options = { kortixSessionScope: SCOPE, networkEnabled: false };

test('a saved copy of this root paints, and the hook says it painted', async () => {
  const hook = await mount('ses_copy_paint', { ...offline, mirror: envelope('ses_copy_paint') });
  expect(hook.value().mirrorState).toBe('painted');
  expect(hook.value().messages).toHaveLength(1);
});

test('a saved copy captured from another root is refused, and the hook says it is absent', async () => {
  const hook = await mount('ses_copy_refuse', { ...offline, mirror: envelope('ses_other_root') });
  expect(hook.value().mirrorState).toBe('absent');
  expect(hook.value().messages).toHaveLength(0);
});

test('a server with no saved copy answers absent', async () => {
  const hook = await mount('ses_copy_none', {
    ...offline,
    mirror: envelope('ses_copy_none', {
      available: false,
      source: 'none',
      message_count: 0,
      messages: [],
    }),
  });
  expect(hook.value().mirrorState).toBe('absent');
});

test('without a root nothing can be read yet', async () => {
  const hook = await mount('', { ...offline, mirror: envelope('ses_any') });
  expect(hook.value().mirrorState).toBe('idle');
});

test('the default read is loading until the server answers, then paints', async () => {
  let answer!: (response: Response) => void;
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return new Promise<Response>((resolve) => {
      answer = resolve;
    });
  }) as unknown as typeof fetch;
  const hook = await mount('ses_copy_read', offline);
  expect(hook.value().mirrorState).toBe('loading');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('/transcript?shape=sync');
  await act(async () => {
    answer(Response.json(envelope('ses_copy_read')));
  });
  await settle();
  expect(hook.value().mirrorState).toBe('painted');
  expect(hook.value().messages).toHaveLength(1);
});

test('an empty answer is not sticky: the envelope that follows it still paints', async () => {
  const hook = await mount('ses_copy_late', { ...offline, mirror: null });
  expect(hook.value().mirrorState).toBe('absent');
  await hook.update('ses_copy_late', { ...offline, mirror: envelope('ses_copy_late') });
  expect(hook.value().mirrorState).toBe('painted');
  expect(hook.value().messages).toHaveLength(1);
});

test('a read that already landed with no messages is absent: there is no copy to wait for', async () => {
  touched.push('ses_copy_empty');
  // An authoritative (runtime) read of an empty thread.
  useSyncStore.getState().hydrate('ses_copy_empty', []);
  const hook = await mount('ses_copy_empty', { ...offline, mirror: envelope('ses_copy_empty') });
  expect(hook.value().mirrorState).toBe('absent');
});

test("a new source waits for its own answer, not the last source's", async () => {
  globalThis.fetch = mock(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const hook = await mount('ses_copy_switch', { ...offline, mirror: null });
  expect(hook.value().mirrorState).toBe('absent');
  // The host stops supplying the copy (its flag turned off): the default read
  // starts, and until it answers nothing is ruled out.
  await hook.update('ses_copy_switch', offline);
  expect(hook.value().mirrorState).toBe('loading');
});
