/**
 * When the IndexedDB transcript mirror actually has to write.
 *
 * The mirror exists so a returning tab paints its last transcript before the
 * server answers. It was rewriting the WHOLE transcript every 500ms for as long
 * as a turn streamed — and `put()` structured-clones what it is given, so a
 * 20MB transcript meant ~40MB/s of transient allocation on the main thread, for
 * a cache whose only job is to be roughly right on the next load. That churn is
 * a leading suspect for the tab discards behind "my session reloaded itself".
 *
 * Two levers, both pure and both tested here:
 *
 *  1. Do not write what is already written. A streamed delta changes the tail,
 *     but plenty of store updates do not change the transcript at all.
 *  2. Write a big transcript less often. Freshness is worth the same to every
 *     session; cost is not, and the mirror is disposable either way — a miss
 *     costs one refetch of data the server is about to send anyway.
 */

/** Base cadence, unchanged for the ordinary small session. */
export const IDB_FLUSH_INTERVAL_MS = 500;
/** Cadence once a transcript is large enough for the clone to be the expense. */
export const IDB_FLUSH_INTERVAL_LARGE_MS = 3_000;
/** Message count past which a transcript counts as large. Around the point a
 *  session has pulled a page or two of history (50 per page). */
export const IDB_LARGE_TRANSCRIPT_MESSAGES = 120;

export function idbFlushIntervalMs(messageCount: number): number {
  return messageCount >= IDB_LARGE_TRANSCRIPT_MESSAGES
    ? IDB_FLUSH_INTERVAL_LARGE_MS
    : IDB_FLUSH_INTERVAL_MS;
}

/**
 * A cheap fingerprint of what a write would store.
 *
 * O(messages) map lookups, never a serialization of the bodies — the whole
 * point is to avoid touching the payload. It moves when a message is added or
 * removed, when the tail changes identity, and when any message's part count
 * changes, which covers every way a transcript grows or is edited (a rewind
 * removes messages; a streamed delta adds parts to the tail).
 *
 * It deliberately does NOT move when a part's CONTENT changes in place without
 * changing the count — a token appended to the same text part. That is the one
 * case a signature this cheap cannot see, and it is also the case where the
 * mirror being one interval stale costs nothing.
 */
export function transcriptSignature(
  messages: ReadonlyArray<{ id?: string }>,
  parts: Readonly<Record<string, unknown[]>>,
): string {
  let partsTotal = 0;
  for (const message of messages) {
    const id = message?.id;
    if (!id) continue;
    partsTotal += parts[id]?.length ?? 0;
  }
  const tail = messages.length > 0 ? (messages[messages.length - 1]?.id ?? '') : '';
  return `${messages.length}:${partsTotal}:${tail}`;
}
