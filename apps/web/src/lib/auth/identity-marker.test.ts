import { describe, expect, test } from 'bun:test';

import { IDENTITY_MARKER_KEY, shouldResetClientState } from './identity-marker';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

/**
 * The rule both `AuthProvider` guards used to get backwards.
 *
 * They were spelled `if (prev && prev !== next)`, which short-circuits on an
 * ABSENT marker and therefore treats "I have no idea whose state this is" as
 * "it is the same user". Absent is UNKNOWN, and unknown state may belong to
 * anyone, so it resets.
 *
 * That was not a theoretical hole: the `SIGNED_OUT` branch deleted the marker,
 * so after an explicit logout the next `SIGNED_IN` always read `prev === null`
 * and the cross-user reset could never fire — at exactly the moment two
 * accounts are most likely to be sharing one browser.
 */
describe('shouldResetClientState — an absent marker is UNKNOWN, not SAME', () => {
  test('no persisted marker resets, even though nothing names another user', () => {
    expect(
      shouldResetClientState({
        inDocumentUserId: null,
        persistedUserId: null,
        nextUserId: USER_A,
      }),
    ).toBe(true);
  });

  test('a persisted marker naming somebody else resets', () => {
    expect(
      shouldResetClientState({
        inDocumentUserId: null,
        persistedUserId: USER_B,
        nextUserId: USER_A,
      }),
    ).toBe(true);
  });

  test('a persisted marker naming this same user does NOT reset', () => {
    // The paired negative. Without it, `return true` passes every case above.
    expect(
      shouldResetClientState({
        inDocumentUserId: null,
        persistedUserId: USER_A,
        nextUserId: USER_A,
      }),
    ).toBe(false);
  });
});

/**
 * The per-document marker exists because the persisted one cannot describe
 * several tabs: it is a single origin-wide value, so two tabs signed into two
 * accounts overwrite each other's while each keeps its own React Query cache.
 */
describe('shouldResetClientState — the in-document marker is per-tab', () => {
  test('a tab that already published another user resets, even when storage agrees', () => {
    expect(
      shouldResetClientState({
        inDocumentUserId: USER_B,
        persistedUserId: USER_A,
        nextUserId: USER_A,
      }),
    ).toBe(true);
  });

  test('a tab that has published nobody yet holds no stale cache of its own', () => {
    // `null` here means EMPTY, not unknown — a document that published no user
    // is holding no other user's in-memory state. The persisted marker still
    // decides, which is why this case turns on it.
    expect(
      shouldResetClientState({
        inDocumentUserId: null,
        persistedUserId: USER_A,
        nextUserId: USER_A,
      }),
    ).toBe(false);
    expect(
      shouldResetClientState({
        inDocumentUserId: null,
        persistedUserId: USER_B,
        nextUserId: USER_A,
      }),
    ).toBe(true);
  });

  test('both markers agreeing with the incoming user is the only no-reset case', () => {
    expect(
      shouldResetClientState({
        inDocumentUserId: USER_A,
        persistedUserId: USER_A,
        nextUserId: USER_A,
      }),
    ).toBe(false);
  });
});

describe('the marker key', () => {
  test('is the value already written in browsers today, so no user is re-reset', () => {
    expect(IDENTITY_MARKER_KEY).toBe('kortix-last-user-id');
  });
});
