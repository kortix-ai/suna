/**
 * The chat's root-conversation pin latch.
 *
 * The live pin (`useSession().opencodeSessionId`) can blip back to null
 * mid-session (a runtime reconnect re-resolving), and the chat must keep its
 * identity through that — hence a latch. But the live value can also CORRECT
 * itself: the SDK's pin precedence only climbs (persisted localStorage mirror
 * → session-row network read → the `/start` result), so a change from one
 * non-null id to another is always a higher-authority source landing — e.g. a
 * stale persisted mirror displaced by the real `/start` pin. A latch that
 * ignored that kept painting — and delivering prompts into — the conversation
 * the stale pin named.
 *
 * So: latch on first resolve, hold through null, follow any non-null change.
 */
export function resolvePinnedRootSessionId(
  pinned: string | null,
  live: string | null,
): string | null {
  return live ?? pinned;
}
