import { beforeEach, describe, expect, test } from 'bun:test';
import { useSessionWorkingStore } from './session-working-store';

/**
 * One receipt and one inbox reading PER SESSION, shared by every observer.
 *
 * Two `useSessionWorking` observers used to be mounted for the same session —
 * one inside `useSession`, one inside the composer — each holding its own
 * `optimistic` prop while sharing one react-query cache entry. The observer
 * without the receipt polled on its own timer and wrote an uninformed "no
 * turns" read into that shared entry, which then defeated the receipt the other
 * one held. There is one set of inputs now, so they cannot disagree.
 */
beforeEach(() => {
  useSessionWorkingStore.getState().reset();
});

describe('send receipts', () => {
  test('a receipt starts unaccepted — no server read may answer for it yet', () => {
    useSessionWorkingStore.getState().noteSendReceipt('sess_1', {
      messageId: 'msg_1',
      atMs: 10,
    });

    expect(useSessionWorkingStore.getState().receipts.sess_1).toEqual({
      messageId: 'msg_1',
      atMs: 10,
      acceptedAtMs: null,
    });
  });

  test('acceptance stamps the instant the server took the send', () => {
    const store = useSessionWorkingStore.getState();
    store.noteSendReceipt('sess_1', { messageId: 'msg_1', atMs: 10 });
    store.acceptSendReceipt('sess_1', 'msg_1', 300);

    expect(useSessionWorkingStore.getState().receipts.sess_1?.acceptedAtMs).toBe(300);
  });

  test('a late acceptance never stamps the NEXT send', () => {
    // The user sent again while the first POST was still on the wire. Stamping
    // the live receipt with the old response would release it for a read that
    // knows nothing about the second send.
    const store = useSessionWorkingStore.getState();
    store.noteSendReceipt('sess_1', { messageId: 'msg_1', atMs: 10 });
    store.noteSendReceipt('sess_1', { messageId: 'msg_2', atMs: 20 });
    store.acceptSendReceipt('sess_1', 'msg_1', 300);

    expect(useSessionWorkingStore.getState().receipts.sess_1).toEqual({
      messageId: 'msg_2',
      atMs: 20,
      acceptedAtMs: null,
    });
  });

  test('clearing drops only that session', () => {
    const store = useSessionWorkingStore.getState();
    store.noteSendReceipt('sess_1', { messageId: 'msg_1', atMs: 10 });
    store.noteSendReceipt('sess_2', { messageId: 'msg_2', atMs: 10 });
    store.clearSendReceipt('sess_1');

    expect(useSessionWorkingStore.getState().receipts.sess_1 ?? null).toBeNull();
    expect(useSessionWorkingStore.getState().receipts.sess_2?.messageId).toBe('msg_2');
  });

  test('an older send failing never drops the NEXT send’s receipt', () => {
    // The mirror of the acceptance guard above, and it was missing: a `/compact`
    // rejected at T+600ms cleared the receipt of an ordinary prompt submitted at
    // T+500ms whose POST was still on the wire. An uninformed `/turn` read then
    // flipped the composer back to Send mid-send — the precise failure
    // `acceptedAtMs` exists to prevent.
    const store = useSessionWorkingStore.getState();
    store.noteSendReceipt('sess_1', { messageId: '/compact', atMs: 10 });
    store.noteSendReceipt('sess_1', { messageId: 'prompt-B', atMs: 20 });
    store.clearSendReceipt('sess_1', '/compact');

    expect(useSessionWorkingStore.getState().receipts.sess_1).toEqual({
      messageId: 'prompt-B',
      atMs: 20,
      acceptedAtMs: null,
    });
  });

  test('clearing without an id still drops whatever is there', () => {
    // Stop and leaving the session know nothing is coming for ANY send.
    const store = useSessionWorkingStore.getState();
    store.noteSendReceipt('sess_1', { messageId: 'msg_1', atMs: 10 });
    store.clearSendReceipt('sess_1');

    expect(useSessionWorkingStore.getState().receipts.sess_1 ?? null).toBeNull();
  });
});

/**
 * The stop's own receipt — the mirror of the send's.
 *
 * A cancel takes ~1.6s to reach the daemon, and every `/turn` read issued in
 * that window still reports the doomed turn. Without this the optimistic idle
 * paint triggered the very refetch that overturned it.
 */
describe('abort receipts', () => {
  test('a stop starts unsettled — no server read may answer for it yet', () => {
    useSessionWorkingStore.getState().noteAbortReceipt('sess_1', 10);

    expect(useSessionWorkingStore.getState().aborts.sess_1).toEqual({
      atMs: 10,
      settledAtMs: null,
    });
  });

  test('a second stop while the first is unsettled keeps the FIRST instant', () => {
    // Two paths issue the same cancel (the SDK's `cancel()` and the host's
    // `issueSessionCancel`). Restamping would extend the bar every time one of
    // them fires again.
    const store = useSessionWorkingStore.getState();
    store.noteAbortReceipt('sess_1', 10);
    store.noteAbortReceipt('sess_1', 40);

    expect(useSessionWorkingStore.getState().aborts.sess_1?.atMs).toBe(10);
  });

  test('settling stamps the acknowledgement instant, once', () => {
    const store = useSessionWorkingStore.getState();
    store.noteAbortReceipt('sess_1', 10);
    store.settleAbortReceipt('sess_1', 300);
    store.settleAbortReceipt('sess_1', 900);

    expect(useSessionWorkingStore.getState().aborts.sess_1?.settledAtMs).toBe(300);
  });

  test('a new send releases the stop — the user is not stopping any more', () => {
    const store = useSessionWorkingStore.getState();
    store.noteAbortReceipt('sess_1', 10);
    store.noteSendReceipt('sess_1', { messageId: 'msg_1', atMs: 20 });

    expect(useSessionWorkingStore.getState().aborts.sess_1 ?? null).toBeNull();
  });
});

describe('inbox readings', () => {
  test('the newest reading wins, and an older one never overwrites it', () => {
    // Two observers of the same inbox query settle in whatever order the
    // network gives them. The projection ranks by observation instant, so a
    // late-arriving OLDER reading must not become the current one.
    const store = useSessionWorkingStore.getState();
    store.noteInboxPending('sess_1', 2, 100);
    store.noteInboxPending('sess_1', 0, 50);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 2, atMs: 100 });

    store.noteInboxPending('sess_1', 0, 200);
    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 0, atMs: 200 });
  });
});

describe('an accepted prompt', () => {
  test('raises the inbox floor so the POST-to-refetch gap is covered', () => {
    // `POST .../prompts` returned 202, so the row exists — but the list query
    // has not refetched yet. Without this, a `/turn` poll landing in that gap
    // answered "no turns" and flipped the composer back to Send while the
    // prompt was queued.
    const store = useSessionWorkingStore.getState();
    store.noteInboxPending('sess_1', 0, 100);
    store.notePromptAccepted('sess_1', 200);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 1, atMs: 200 });
  });

  test('never lowers a bigger count the list already reported', () => {
    const store = useSessionWorkingStore.getState();
    store.noteInboxPending('sess_1', 3, 100);
    store.notePromptAccepted('sess_1', 200);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 3, atMs: 200 });
  });

  test('never overwrites a NEWER list reading', () => {
    const store = useSessionWorkingStore.getState();
    store.noteInboxPending('sess_1', 0, 500);
    store.notePromptAccepted('sess_1', 200);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 0, atMs: 500 });
  });
});

describe('clearSession', () => {
  test('drops every input for ONE session and leaves the rest', () => {
    const store = useSessionWorkingStore.getState();
    store.reset();
    store.noteSendReceipt('a', { messageId: 'm1', atMs: 1 });
    store.noteAbortReceipt('a', 2);
    store.noteInboxPending('a', 1, 3);
    store.noteSendReceipt('b', { messageId: 'm2', atMs: 4 });

    useSessionWorkingStore.getState().clearSession('a');

    const after = useSessionWorkingStore.getState();
    expect(after.receipts['a']).toBeUndefined();
    expect(after.aborts['a']).toBeUndefined();
    expect(after.inbox['a']).toBeUndefined();
    expect(after.receipts['b']?.messageId).toBe('m2');
  });

  test('a session with nothing stored is a no-op, not a state churn', () => {
    const store = useSessionWorkingStore.getState();
    store.reset();
    const before = useSessionWorkingStore.getState().receipts;
    useSessionWorkingStore.getState().clearSession('ghost');
    expect(useSessionWorkingStore.getState().receipts).toBe(before);
  });
});
