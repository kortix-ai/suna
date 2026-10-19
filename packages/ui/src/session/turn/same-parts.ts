/**
 * Element-wise identity for a list of parts.
 *
 * The turn's segments are memoised (`session-chat.tsx`), so a burst's `parts`
 * array keeps its identity until the turn's parts change. That is enough for
 * every burst EXCEPT the one being streamed into — and while a turn streams,
 * `allParts` changes on every frame, which hands every burst in that turn a
 * fresh array even though only the last one grew.
 *
 * Comparing element by element is what saves the rest. A part object is
 * replaced when it changes and kept when it does not, so an unchanged burst
 * compares equal against its new array and its whole subtree is skipped.
 *
 * The loop is O(n) on a list that is almost always under ~20, against a subtree
 * whose re-render runs `mergeBurstSteps`, `groupSteps`, `stepLabel` per part and
 * — if anything below is open — shiki. The comparison is not close to the cost
 * it avoids.
 *
 * No React import: this is a predicate, and it is unit-tested as one.
 */
export function samePartsList<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
