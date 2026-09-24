import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearOptimistic,
  isOptimistic,
  selectSessionsToEvict,
  useSyncStore,
} from './sync-store';
import type { MessageWithParts, Part } from './types';

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

function userMessage(id: string, created: number, sessionID = 'session-1'): MessageWithParts {
  return {
    info: { id, role: 'user', sessionID, time: { created } },
    parts: [{ id: `${id}-text`, type: 'text', text: `prompt ${id}` } as Part],
  };
}

function toolMessage(id: string, created: number, status: string): MessageWithParts {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 'session-1',
      parentID: 'u1',
      time: { created, completed: created + 5 },
      metadata: { tokens: { input: 10, output: 20 }, cost: 0.01 },
    },
    parts: [
      { id: `${id}-step`, type: 'step-start' } as Part,
      { id: `${id}-text`, type: 'text', text: 'Reading the file.' } as Part,
      {
        id: `${id}-tool`,
        type: 'tool',
        callID: 'call-1',
        tool: 'read',
        input: { filePath: '/workspace/a.ts' },
        state: { status, output: 'contents', metadata: { lines: 12, preview: ['a', 'b'] } },
        time: { start: created, end: created + 3 },
      } as unknown as Part,
    ],
  };
}

function transcript(toolStatus = 'completed'): MessageWithParts[] {
  return [
    userMessage('u1', 1),
    toolMessage('a1', 2, toolStatus),
    userMessage('u2', 3),
    toolMessage('a2', 4, 'completed'),
  ];
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe('hydrate structural sharing', () => {
  beforeEach(() => useSyncStore.getState().reset());

  test('an identical payload keeps every message object', () => {
    const store = useSyncStore.getState();
    store.hydrate('session-1', clone(transcript()));
    const before = useSyncStore.getState().messages['session-1'];

    useSyncStore.getState().hydrate('session-1', clone(transcript()));
    const after = useSyncStore.getState().messages['session-1'];

    expect(after.length).toBe(before.length);
    after.forEach((message, index) => expect(message).toBe(before[index]));
    expect(after).toBe(before);
  });

  test('one changed tool status replaces only that message and that part', () => {
    useSyncStore.getState().hydrate('session-1', clone(transcript('running')));
    const before = useSyncStore.getState().messages['session-1'];

    useSyncStore.getState().hydrate('session-1', clone(transcript('completed')));
    const after = useSyncStore.getState().messages['session-1'];

    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toBe(before[3]);
    expect(after[1].parts[0]).toBe(before[1].parts[0]);
    expect(after[1].parts[1]).toBe(before[1].parts[1]);
    expect(after[1].parts[2]).not.toBe(before[1].parts[2]);
    expect((after[1].parts[2] as any).state.status).toBe('completed');
  });

  test('changed tool output with the same status is not reused', () => {
    useSyncStore.getState().hydrate('session-1', clone(transcript()));
    const before = useSyncStore.getState().messages['session-1'];
    const next = clone(transcript());
    (next[1].parts[2] as any).state.metadata.preview = ['a', 'c'];

    useSyncStore.getState().hydrate('session-1', next);
    const after = useSyncStore.getState().messages['session-1'];
    expect(after[1]).not.toBe(before[1]);
    expect((after[1].parts[2] as any).state.metadata.preview).toEqual(['a', 'c']);
  });

  test('longer streamed text still wins over a shorter snapshot', () => {
    const base = clone(transcript());
    useSyncStore.getState().hydrate('session-1', base);
    useSyncStore.getState().appendPartDelta('a2', 'a2-text', 'session-1', 'text', ' More.');
    const streamed = useSyncStore.getState().messages['session-1'][3].parts[1];

    useSyncStore.getState().hydrate('session-1', clone(transcript()));
    expect(useSyncStore.getState().messages['session-1'][3].parts[1]).toBe(streamed);
  });
});

describe('scoped part updates', () => {
  beforeEach(() => useSyncStore.getState().reset());

  test('upsertPart with a sessionID touches only that session', () => {
    useSyncStore.getState().hydrate('session-1', [message('m1')]);
    useSyncStore.getState().hydrate('session-2', [message('m2')]);
    const other = useSyncStore.getState().messages['session-2'];

    useSyncStore
      .getState()
      .upsertPart('m1', { id: 'p1', type: 'text', text: 'hi' } as Part, 'session-1');

    const state = useSyncStore.getState();
    expect(state.messages['session-1'][0].parts.map((part) => part.id)).toEqual(['p1']);
    expect(state.messages['session-2']).toBe(other);
  });

  test('upsertPart with a sessionID that does not hold the message is a no-op', () => {
    useSyncStore.getState().hydrate('session-1', [message('m1')]);
    const before = useSyncStore.getState().messages;
    useSyncStore
      .getState()
      .upsertPart('m1', { id: 'p1', type: 'text', text: 'hi' } as Part, 'session-2');
    expect(useSyncStore.getState().messages).toBe(before);
  });

  test('upsertPart without a sessionID still finds the message', () => {
    useSyncStore.getState().hydrate('session-1', [message('m1')]);
    useSyncStore.getState().hydrate('session-2', [message('m2')]);
    useSyncStore.getState().upsertPart('m2', { id: 'p2', type: 'text', text: 'x' } as Part);
    expect(useSyncStore.getState().messages['session-2'][0].parts.length).toBe(1);
  });

  test('the prefix-growth guard still rejects a stale snapshot', () => {
    useSyncStore.getState().hydrate('session-1', [message('m1')]);
    const store = useSyncStore.getState();
    store.upsertPart('m1', { id: 'p1', type: 'text', text: 'Hello world' } as Part, 'session-1');
    store.upsertPart('m1', { id: 'p1', type: 'text', text: 'world' } as Part, 'session-1');
    expect((useSyncStore.getState().messages['session-1'][0].parts[0] as any).text).toBe(
      'Hello world',
    );
  });

  test('removePart with a sessionID removes from that session only', () => {
    useSyncStore.getState().hydrate('session-1', [message('m1')]);
    const store = useSyncStore.getState();
    store.upsertPart('m1', { id: 'p1', type: 'text', text: 'a' } as Part, 'session-1');
    store.removePart('m1', 'p1', 'session-2');
    expect(useSyncStore.getState().messages['session-1'][0].parts.length).toBe(1);
    useSyncStore.getState().removePart('m1', 'p1', 'session-1');
    expect(useSyncStore.getState().messages['session-1'][0].parts.length).toBe(0);
  });
});

describe('optimistic id pruning', () => {
  beforeEach(() => useSyncStore.getState().reset());

  test('hydrate drops the optimistic id once the real user message replaces it', () => {
    useSyncStore.getState().hydrate('session-1', [message('a0', 0)]);
    useSyncStore.getState().addOptimisticMessage('session-1', userMessage('opt-1', 5));
    expect(isOptimistic('opt-1')).toBe(true);

    useSyncStore.getState().hydrate('session-1', [message('a0', 0), userMessage('u-real', 5)]);

    const ids = useSyncStore.getState().messages['session-1'].map((m) => m.info.id);
    expect(ids).toEqual(['a0', 'u-real']);
    expect(isOptimistic('opt-1')).toBe(false);
  });

  test('hydrate keeps the optimistic id while no real user message has arrived', () => {
    useSyncStore.getState().hydrate('session-1', [message('a0', 0)]);
    useSyncStore.getState().addOptimisticMessage('session-1', userMessage('opt-2', 5));
    useSyncStore.getState().hydrate('session-1', [message('a0', 0)]);
    expect(isOptimistic('opt-2')).toBe(true);
  });

  test('clearOptimistic forgets the given ids', () => {
    useSyncStore.getState().addOptimisticMessage('session-1', userMessage('opt-3', 5));
    clearOptimistic(['opt-3']);
    expect(isOptimistic('opt-3')).toBe(false);
  });

  test('removeMessage forgets an optimistic id', () => {
    useSyncStore.getState().addOptimisticMessage('session-1', userMessage('opt-4', 5));
    useSyncStore.getState().removeMessage('session-1', 'opt-4');
    expect(isOptimistic('opt-4')).toBe(false);
  });
});

describe('session eviction', () => {
  beforeEach(() => useSyncStore.getState().reset());

  function load(sessionId: string) {
    useSyncStore.getState().hydrate(sessionId, [
      { ...message(`${sessionId}-m`), info: { ...message(`${sessionId}-m`).info, sessionID: sessionId } },
    ]);
    useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
    useSyncStore.getState().addQuestion(sessionId, { id: `${sessionId}-q`, sessionID: sessionId, questions: [] });
    useSyncStore.getState().addPermission(sessionId, {
      id: `${sessionId}-p`,
      sessionID: sessionId,
      permission: 'bash',
      input: {},
    });
  }

  test('selectSessionsToEvict keeps kept, busy, and optimistic sessions', () => {
    for (const id of ['live', 'recent', 'old', 'busy', 'sending', 'stub']) load(id);
    useSyncStore.getState().setStatus('busy', { type: 'busy' });
    useSyncStore.getState().addOptimisticMessage('sending', userMessage('opt-send', 9, 'sending'));

    const evict = selectSessionsToEvict(useSyncStore.getState(), new Set(['live', 'recent']));
    expect(evict.sort()).toEqual(['old', 'stub']);
  });

  test('evictSessions removes messages, status, questions, and permissions', () => {
    load('keep');
    load('drop');
    const kept = useSyncStore.getState().messages.keep;
    useSyncStore.getState().evictSessions(['drop']);

    const state = useSyncStore.getState();
    expect('drop' in state.messages).toBe(false);
    expect('drop' in state.sessionStatus).toBe(false);
    expect('drop' in state.questions).toBe(false);
    expect('drop' in state.permissions).toBe(false);
    expect(state.messages.keep).toBe(kept);
    expect(state.questions.keep.length).toBe(1);
  });

  test('evictSessions with nothing to evict leaves state untouched', () => {
    load('keep');
    const before = useSyncStore.getState();
    useSyncStore.getState().evictSessions([]);
    useSyncStore.getState().evictSessions(['missing']);
    expect(useSyncStore.getState().messages).toBe(before.messages);
  });
});

describe('addPermission', () => {
  beforeEach(() => useSyncStore.getState().reset());

  function permission(id: string) {
    return { id, sessionID: 'session-1', permission: 'bash', input: {} } as const;
  }

  test('appends a new permission to the session list', () => {
    useSyncStore.getState().addPermission('session-1', permission('perm-1'));
    expect(useSyncStore.getState().permissions['session-1']).toEqual([permission('perm-1')]);
  });

  test('skips a permission whose id is already in that session\'s list', () => {
    useSyncStore.getState().addPermission('session-1', permission('perm-1'));
    useSyncStore.getState().addPermission('session-1', permission('perm-1'));
    expect(useSyncStore.getState().permissions['session-1']).toEqual([permission('perm-1')]);
  });

  test('a duplicate id in one session does not block the same id in another', () => {
    useSyncStore.getState().addPermission('session-1', permission('perm-1'));
    useSyncStore.getState().addPermission('session-2', permission('perm-1'));
    expect(useSyncStore.getState().permissions['session-1']).toEqual([permission('perm-1')]);
    expect(useSyncStore.getState().permissions['session-2']).toEqual([permission('perm-1')]);
  });
});
