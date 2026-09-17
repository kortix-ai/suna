import { beforeEach, describe, expect, test } from 'bun:test';
import { type QueuedDraft, useQueuedDraftStore } from './queued-draft-store';

const draft = (clientMessageId: string, over: Partial<QueuedDraft> = {}): QueuedDraft => ({
  clientMessageId,
  text: `text ${clientMessageId}`,
  files: [],
  createdAtMs: 1_000,
  posted: false,
  ...over,
});

const drafts = (sessionId: string) => useQueuedDraftStore.getState().bySession[sessionId] ?? [];

describe('useQueuedDraftStore', () => {
  beforeEach(() => useQueuedDraftStore.setState({ bySession: {} }));

  test('keeps drafts in the order they were queued, per session', () => {
    const { add } = useQueuedDraftStore.getState();
    add('s1', draft('a'));
    add('s1', draft('b'));
    add('s2', draft('c'));
    expect(drafts('s1').map((d) => d.clientMessageId)).toEqual(['a', 'b']);
    expect(drafts('s2').map((d) => d.clientMessageId)).toEqual(['c']);
  });

  test('markPosted flips only the named draft', () => {
    const { add, markPosted } = useQueuedDraftStore.getState();
    add('s1', draft('a'));
    add('s1', draft('b'));
    markPosted('s1', 'b');
    expect(drafts('s1').map((d) => d.posted)).toEqual([false, true]);
  });

  test('remove drops the named drafts and forgets an emptied session', () => {
    const { add, remove } = useQueuedDraftStore.getState();
    add('s1', draft('a'));
    add('s1', draft('b'));
    remove('s1', ['a', 'b']);
    expect('s1' in useQueuedDraftStore.getState().bySession).toBe(false);
  });

  test('prune drops posted drafts the inbox stopped listing, never an unposted one', () => {
    // An unposted draft is still uploading: its row does not exist yet, so its
    // absence from the list says nothing.
    const { add, prune } = useQueuedDraftStore.getState();
    add('s1', draft('delivered', { posted: true }));
    add('s1', draft('listed', { posted: true }));
    add('s1', draft('uploading'));
    prune('s1', new Set(['listed']));
    expect(drafts('s1').map((d) => d.clientMessageId)).toEqual(['listed', 'uploading']);
  });

  test('a no-op write keeps the same state object, so subscribers do not re-render', () => {
    const { add, prune, markPosted, remove } = useQueuedDraftStore.getState();
    add('s1', draft('a', { posted: true }));
    const before = useQueuedDraftStore.getState().bySession;
    prune('s1', new Set(['a']));
    markPosted('s1', 'a');
    remove('s1', ['missing']);
    expect(useQueuedDraftStore.getState().bySession).toBe(before);
  });
});
