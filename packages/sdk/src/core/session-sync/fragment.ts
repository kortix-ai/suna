/**
 * Is this session's transcript a FRAGMENT — messages the live stream rebuilt
 * after an eviction, with everything before them missing?
 *
 * The sync store already carries the exact signature, in two pieces:
 *
 *   - eviction drops a detached session's messages and MARKS the id
 *   - every path that re-establishes the session authoritatively — `hydrate`,
 *     `clearSession`, `optimisticAdd` — CLEARS that mark
 *   - `applyEvent`, the live stream's own path, does not
 *
 * So messages present while the mark is still set can only have come from
 * frames that arrived after the eviction. The transcript starts mid-conversation
 * and nothing else will correct it: the mount already ran, so no `initial` read
 * is coming, and the liveness poll only runs while the session is working.
 *
 * Named and left open by 5a7a43517f, which removed the IndexedDB mirror that
 * used to repaint underneath such a fragment: "no reconcile is keyed on
 * eviction … can sit on a partial transcript until a reload."
 */
export function transcriptIsFragment(input: {
  /** The store holds at least one message for this session. */
  hasMessages: boolean;
  /** The store still marks this session's transcript as evicted. */
  wasEvicted: boolean;
}): boolean {
  return input.hasMessages && input.wasEvicted;
}
