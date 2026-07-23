import { beforeEach, describe, expect, test } from 'bun:test';
import { useSyncStore } from './sync-store';
import type { MessageWithParts } from './types';

function message(id: string): MessageWithParts {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 'session-1',
      time: { created: 1 },
    },
    parts: [],
  };
}

describe('mobile session hydration', () => {
  beforeEach(() => useSyncStore.getState().reset());

  test('merges an older page without discarding the current tail', () => {
    useSyncStore.getState().hydrate('session-1', [message('03'), message('04')]);
    useSyncStore.getState().hydrate('session-1', [message('01'), message('02')]);

    expect(useSyncStore.getState().messages['session-1'].map((entry) => entry.info.id)).toEqual([
      '01',
      '02',
      '03',
      '04',
    ]);
  });
});
