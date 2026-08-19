import { beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/v2/client';

import { useSyncStore } from '../../browser/stores/sync-store';
import { qk } from '../query-keys';
import { opencodeKeys } from '../use-opencode-sessions';
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
type InvalidateFilters = {
  queryKey?: readonly unknown[];
  predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
};

function renderEventStreamRefs(): ReturnType<typeof useEventStreamRefs> & {
  invalidated: InvalidateFilters[];
} {
  let captured: ReturnType<typeof useEventStreamRefs> | undefined;
  const invalidated: InvalidateFilters[] = [];
  const queryClient = new QueryClient();
  const realInvalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters?: InvalidateFilters) => {
    invalidated.push(filters ?? {});
    return realInvalidate(filters as never);
  }) as typeof queryClient.invalidateQueries;
  function Harness() {
    captured = useEventStreamRefs({
      queryClient,
      stopCompaction: () => {},
      applySyncEvent: (event: OpenCodeSdkEvent) => useSyncStore.getState().applyEvent(event),
    });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (!captured) throw new Error('useEventStreamRefs did not produce a result');
  return { ...captured, invalidated };
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
    // The handler's OWN `setStatus(idle)` is gone. It was a second, direct
    // claim about the session made by code whose only evidence is that one
    // runtime instance went away — the control plane may still hold the turn,
    // and the box may already be resuming under it. The idle below is the sync
    // store's own rule for an error event (errors terminate the response),
    // reached through the synthesized `session.error` this handler is designed
    // to echo; one writer, not two. What this handler now does about the
    // session's state is ASK: it invalidates the server-truth reads and lets
    // the projection answer.
    expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: 'idle' });
    expect(refs.invalidated.length).toBeGreaterThan(0);
  });

  test('re-reads the turn authority and the prompt inbox instead of declaring', () => {
    // `server.instance.disposed` carries no project id and no Kortix session
    // id, so the invalidation is by SHAPE: every `.../turn` and `.../prompts`
    // entry the tab holds. Both are exactly the reads `projectWorking` stands
    // on, and both can contradict "the session stopped".
    const refs = renderEventStreamRefs();
    refs.markSessionAbortedLocally.current('ses_any');

    expect(refs.invalidated).toHaveLength(1);
    const matches = refs.invalidated[0]?.predicate;
    expect(matches).toBeFunction();
    expect(matches!({ queryKey: qk.project.sessionTurn('p1', 's1') })).toBe(true);
    expect(matches!({ queryKey: qk.project.sessionPrompts('p1', 's1') })).toBe(true);
    // Not the transcript, not the session row, not another factory's keys.
    expect(matches!({ queryKey: qk.project.messages('p1', 's1') })).toBe(false);
    expect(matches!({ queryKey: qk.project.session('p1', 's1') })).toBe(false);
    expect(matches!({ queryKey: opencodeKeys.runtimeSession('s1') })).toBe(false);
  });

  test('the un-echoed bubble of a prompt the inbox will redeliver is never wiped', () => {
    // Its sibling `reconcileMissingBusySessions` has guarded this since the
    // "message sent from home vanishes" bug; this path never did, and it runs
    // for EVERY non-idle session in the tab on one `server.instance.disposed`
    // frame — the exact moment a durable prompt is about to be redelivered.
    useSyncStore
      .getState()
      .optimisticAdd('ses_opt', { id: 'opt_1', sessionID: 'ses_opt', role: 'user' } as never, []);

    const refs = renderEventStreamRefs();
    refs.markSessionAbortedLocally.current('ses_opt');

    expect(useSyncStore.getState().messages.ses_opt?.some((m) => m.id === 'opt_1')).toBe(true);
  });

  test('a session with nothing optimistic still has its optimistic tracking swept', () => {
    useSyncStore.getState().upsertMessage('ses_3', {
      id: 'msg_a',
      sessionID: 'ses_3',
      role: 'assistant',
    } as never);

    const refs = renderEventStreamRefs();
    refs.markSessionAbortedLocally.current('ses_3');

    expect(useSyncStore.getState().hasOptimisticMessages('ses_3')).toBe(false);
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

/**
 * The repair for a MISSED terminal frame, and the only one the raw status slot
 * has.
 *
 * `client.session.status()` is a REST read of the runtime's COMPLETE set of
 * non-idle sessions, so a session's ABSENCE from it is a positive statement —
 * "this one is not busy" — not an inference from silence. Removing it left a
 * lost `session.idle` (a laptop sleeping mid-turn, a stream reconnect) latched
 * in `sessionStatus[...]` for the lifetime of the tab, and two live surfaces
 * still read that slot directly: the session panel's `isSessionBusy`, and
 * `SubAgentStatusBanner`'s retry countdown for CHILD sessions — which have no
 * Kortix session row, so `GET .../turn` can never cover them and the working
 * projection cannot either.
 */
describe('reconcileMissingBusySessions', () => {
  test('walks a session the runtime no longer reports as busy back to idle', () => {
    useSyncStore.getState().setStatus('ses_1', { type: 'busy' });

    const refs = renderEventStreamRefs();
    refs.reconcileMissingBusySessions.current({});

    expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: 'idle' });
  });

  test('a session the runtime STILL reports is left alone', () => {
    useSyncStore.getState().setStatus('ses_1', { type: 'busy' });

    const refs = renderEventStreamRefs();
    refs.reconcileMissingBusySessions.current({ ses_1: { type: 'busy' } as never });

    expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: 'busy' });
  });

  test('a brand-new session with an unsent optimistic message is never idled', () => {
    // Its first prompt has not reached the server, so it is absent from the
    // snapshot for an innocent reason. Idling it runs `clearOptimisticMessages`
    // and wipes the user's own bubble before the real `message.updated` — the
    // "message sent from home vanishes" bug.
    useSyncStore.getState().setStatus('ses_new', { type: 'busy' });
    useSyncStore
      .getState()
      .optimisticAdd('ses_new', { id: 'opt_1', sessionID: 'ses_new', role: 'user' } as never, []);

    const refs = renderEventStreamRefs();
    refs.reconcileMissingBusySessions.current({});

    expect(useSyncStore.getState().sessionStatus.ses_new).toEqual({ type: 'busy' });
  });
});
