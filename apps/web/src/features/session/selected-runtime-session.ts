/**
 * The OpenCode session a `?oc=` link names — a sub-session row in the project
 * sidebar — and whether that `oc` names nothing and should be dropped.
 *
 * The sidebar learns of sub-sessions from the Kortix session row. The page's
 * runtime session list is a separate, 5-minute cache, so a child the agent
 * created a moment ago is not in it yet. Dropping `oc` on that miss sent every
 * click on a fresh sub-session back to its parent. The id is looked up on its
 * own instead, and `oc` goes only once that lookup has settled with nothing.
 */
export function resolveSelectedRuntimeSession<S extends { id: string }>(input: {
  selectedId: string | null;
  listed: readonly S[];
  listLoading: boolean;
  /** `useRuntimeSession(selectedId)`: `settled` once it answered or gave up. */
  lookup: { data: S | undefined; settled: boolean };
}): { session: S | null; drop: boolean } {
  const { selectedId, listed, listLoading, lookup } = input;
  if (!selectedId) return { session: null, drop: false };
  const session =
    listed.find((candidate) => candidate.id === selectedId) ??
    (lookup.data?.id === selectedId ? lookup.data : null);
  if (session) return { session, drop: false };
  return { session: null, drop: !listLoading && lookup.settled };
}
