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

  test('add upserts by clientMessageId, so a Retry replaces its row instead of drawing a second', () => {
    // Retry re-enters `handleSend` with the SAME `clientMessageId`. Appending
    // would list the message twice, under one React key.
    const { add } = useQueuedDraftStore.getState();
    add('s1', draft('a', { text: 'first try', createdAtMs: 1_000 }));
    add('s1', draft('b'));
    add('s1', draft('a', { text: 'retried', createdAtMs: 9_000, posted: true }));
    expect(drafts('s1').map((d) => d.clientMessageId)).toEqual(['a', 'b']);
    expect(drafts('s1')[0]).toMatchObject({ text: 'retried', posted: true });
    // Enter time, not Retry time: the queue is ordered by when the user sent it.
    expect(drafts('s1')[0].createdAtMs).toBe(1_000);
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

describe('setText — an in-place edit of a queued message', () => {
  test('rewrites only the named draft, and keeps its files and its place', () => {
    const store = useQueuedDraftStore.getState();
    store.add('s-edit', { clientMessageId: 'a', messageId: 'w_a', text: 'one', files: [], createdAtMs: 1, posted: true });
    store.add('s-edit', { clientMessageId: 'b', messageId: 'w_b', text: 'two', files: [], createdAtMs: 2, posted: true });
    useQueuedDraftStore.getState().setText('s-edit', 'a', 'one, edited');
    const drafts = useQueuedDraftStore.getState().bySession['s-edit'];
    expect(drafts.map((d) => [d.clientMessageId, d.text])).toEqual([
      ['a', 'one, edited'],
      ['b', 'two'],
    ]);
  });

  test('a draft that is not there changes nothing', () => {
    const before = useQueuedDraftStore.getState().bySession;
    useQueuedDraftStore.getState().setText('s-none', 'x', 'y');
    expect(useQueuedDraftStore.getState().bySession).toBe(before);
  });
});
