import { beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/v2/client';

import { useSyncStore } from '../../browser/stores/sync-store';
import { useEventStreamRefs } from './use-event-stream-refs';

// T2: `markSessionAbortedLocally` (invoked from the
// `server.instance.disposed` handler in `handle-event.ts` for EVERY
// non-idle session in the tab) is pure infrastructure — OpenCode
// disposed/respawned mid-stream — never a user action. It must tag the
// synthetic error it patches with `data.reason: 'runtime-disposed'` so
// apps/web can tell it apart from a real user Stop (`applyOptimisticAbort`,
// which tags `'user'`) and render nothing for it instead of an "Interrupted"
// row. See `core/http/abort-error.ts` for the reason union.

/**
 * Renders `useEventStreamRefs(...)` inside a throwaway component via
 * `renderToStaticMarkup` (no-DOM-needed pattern used by
 * `session-agent-name-guard.test.ts` / `use-model-store.test.ts`) and
 * returns the hook's result. Every `useRef` initializer resolves fully
 * synchronously during this render, so the captured refs are safe to read
 * and call after `renderToStaticMarkup` returns.
 */
function renderEventStreamRefs(): ReturnType<typeof useEventStreamRefs> {
  let captured: ReturnType<typeof useEventStreamRefs> | undefined;
  function Harness() {
    captured = useEventStreamRefs({
      queryClient: new QueryClient(),
      stopCompaction: () => {},
      applySyncEvent: (event: OpenCodeSdkEvent) => useSyncStore.getState().applyEvent(event),
    });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (!captured) throw new Error('useEventStreamRefs did not produce a result');
  return captured;
}

beforeEach(() => {
  useSyncStore.getState().reset();
});

describe('markSessionAbortedLocally', () => {
  test('patches the last assistant message with a SyntheticAbortError tagged reason: "runtime-disposed"', () => {
    useSyncStore.getState().upsertMessage('ses_1', {
      id: 'msg_a',
      sessionID: 'ses_1',
      role: 'user',
    } as never);
    useSyncStore.getState().upsertMessage('ses_1', {
      id: 'msg_b',
      sessionID: 'ses_1',
      role: 'assistant',
    } as never);
    useSyncStore.getState().setStatus('ses_1', { type: 'busy' });

    const refs = renderEventStreamRefs();
    refs.markSessionAbortedLocally.current('ses_1');

    const assistant = useSyncStore
      .getState()
      .messages.ses_1?.find((m) => m.id === 'msg_b') as { error?: unknown } | undefined;
    expect(assistant?.error).toEqual({
      name: 'AbortError',
      data: {
        message: 'The operation was aborted because the runtime shut down.',
        reason: 'runtime-disposed',
      },
    });
    // Errors terminate the response — status flips to idle, same as a real
    // wire `session.error`.
    expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: 'idle' });
  });

  test('a custom message is preserved verbatim alongside the reason tag', () => {
    useSyncStore.getState().upsertMessage('ses_2', {
      id: 'msg_a',
      sessionID: 'ses_2',
      role: 'assistant',
    } as never);

    const refs = renderEventStreamRefs();
    refs.markSessionAbortedLocally.current('ses_2', 'custom disposal message');

    const assistant = useSyncStore
      .getState()
      .messages.ses_2?.find((m) => m.id === 'msg_a') as { error?: { data?: { message?: string; reason?: string } } } | undefined;
    expect(assistant?.error?.data?.message).toBe('custom disposal message');
    expect(assistant?.error?.data?.reason).toBe('runtime-disposed');
  });

  test('no-ops for an empty sessionID', () => {
    const refs = renderEventStreamRefs();
    expect(() => refs.markSessionAbortedLocally.current('')).not.toThrow();
  });
});
