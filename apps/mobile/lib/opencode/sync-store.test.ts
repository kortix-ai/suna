import { beforeEach, describe, expect, test } from 'bun:test';
import { useSyncStore } from './sync-store';
import type { MessageWithParts } from './types';

function message(id: string, created = 1): MessageWithParts {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 'session-1',
      time: { created },
    },
    parts: [],
  };
}

describe('mobile session hydration', () => {
  beforeEach(() => useSyncStore.getState().reset());

  test('merges an older page without discarding the current tail', () => {
    useSyncStore.getState().hydrate('session-1', [message('03'), message('04')]);
    useSyncStore.getState().hydrate('session-1', [message('01'), message('02')]);

    expect(
      useSyncStore.getState().messages['session-1'].map((entry) => entry.info.id),
    ).toEqual(['01', '02', '03', '04']);
  });

  // The server page (`MessageV2.page()`) is ordered by `time_created` and
  // always has been. Ids do not ascend with time (OpenCode 1.18.15 retired
  // that invariant), and `localeCompare` is not even byte order — so mobile
  // and web disagreed on identical data. The page order IS the order.
  test('keeps the server page order — ids are not a chronology', () => {
    // A first hydrate of an empty session is accepted verbatim; the merge
    // path only runs once the session already holds something.
    useSyncStore.getState().hydrate('session-1', [message('msg_zz', 10)]);
    useSyncStore
      .getState()
      .hydrate('session-1', [message('msg_zz', 10), message('msg_aa', 20)]);

    expect(
      useSyncStore.getState().messages['session-1'].map((entry) => entry.info.id),
    ).toEqual(['msg_zz', 'msg_aa']);
  });

  test('a locally-known message the page lacks lands by time, not by id', () => {
    // An SSE-delivered reply the next page read has not caught up with.
    useSyncStore.getState().hydrate('session-1', [message('msg_zz', 30)]);
    useSyncStore
      .getState()
      .hydrate('session-1', [message('msg_bb', 10), message('msg_aa', 20)]);

    expect(
      useSyncStore.getState().messages['session-1'].map((entry) => entry.info.id),
    ).toEqual(['msg_bb', 'msg_aa', 'msg_zz']);
  });

  test('an older locally-known message sorts ahead of a newer page', () => {
    useSyncStore.getState().hydrate('session-1', [message('msg_zz', 5)]);
    useSyncStore
      .getState()
      .hydrate('session-1', [message('msg_bb', 10), message('msg_aa', 20)]);

    expect(
      useSyncStore.getState().messages['session-1'].map((entry) => entry.info.id),
    ).toEqual(['msg_zz', 'msg_bb', 'msg_aa']);
  });
});
