/**
 * Who the client state currently in front of the user belongs to.
 *
 * `AuthProvider` keeps two markers because they answer two different questions,
 * and neither one can answer the other's:
 *
 *  - **`persistedUserId`** — `localStorage['kortix-last-user-id']`. It describes
 *    the ORIGIN-WIDE persisted state: `localStorage` itself and the IndexedDB
 *    session cache. One bucket, shared by every tab and every document.
 *  - **`inDocumentUserId`** — a `useRef` inside the provider. It describes the
 *    IN-MEMORY caches of THIS document: the React Query cache and the
 *    `current-account` store. Those are per-document, and a single origin-wide
 *    localStorage key cannot describe several tabs at once — two tabs signed
 *    into two accounts overwrite each other's marker while each keeps its own
 *    query cache intact.
 *
 * Either marker disagreeing means the state on screen is not this user's.
 */
/** The origin-wide marker key. One name, read and written in one place. */
export const IDENTITY_MARKER_KEY = 'kortix-last-user-id';

export type IdentityMarkers = {
  /** The last user this DOCUMENT published, or `null` if it has published none. */
  inDocumentUserId: string | null;
  /** The marker in origin-wide storage, or `null` when absent or unreadable. */
  persistedUserId: string | null;
  /** The user who is signing in now. */
  nextUserId: string;
};

/**
 * Whether the client state must be wiped before `nextUserId` is published.
 *
 * The rule the previous guards got backwards was `if (prev && prev !== next)`:
 * an ABSENT marker short-circuited to "no reset", i.e. it was read as SAME
 * USER. Absent is not same — it is UNKNOWN, and unknown state may belong to
 * anyone, so it resets. That mattered because the `SIGNED_OUT` branch deleted
 * the very marker the later `SIGNED_IN` comparison needed, so after an explicit
 * logout the cross-user reset could never fire at all.
 *
 * `inDocumentUserId` is the one place `null` legitimately means "nothing", not
 * "unknown": a document that has published no user is holding no other user's
 * in-memory cache. Its absence therefore does not force a reset on its own —
 * the persisted marker still has to agree.
 *
 * Cost of erring this way: a first-ever sign-in in a clean browser runs one
 * reset over empty caches, and a browser that blocks storage runs one per cold
 * load. Both are wasted work, never wrong state. The opposite error hands one
 * account another account's cached workspaces.
 *
 * The persisted marker does NOT survive a reset, on `SIGNED_OUT` or anywhere
 * else. `resetClientState()` sweeps every `localStorage`/`sessionStorage` key
 * this app owns (`clear-local-storage.ts`'s prefix sweep), and
 * `IDENTITY_MARKER_KEY` ('kortix-last-user-id') matches that sweep's own
 * `'kortix-'` prefix and is not on `KEEP_STORAGE_KEYS` — so any caller that
 * resets deletes the very key it is about to compare against on the next
 * call. That is exactly why absent must read as UNKNOWN rather than as "no
 * marker, so no previous user, so nothing to reset": a real explicit sign-out
 * sweeps this key as a SIDE EFFECT of resetting, not as a special case coded
 * for it, and the UNKNOWN-resets rule above is what keeps that side effect
 * safe instead of self-disarming.
 */
export function shouldResetClientState({
  inDocumentUserId,
  persistedUserId,
  nextUserId,
}: IdentityMarkers): boolean {
  if (inDocumentUserId !== null && inDocumentUserId !== nextUserId) return true;
  return persistedUserId !== nextUserId;
}
