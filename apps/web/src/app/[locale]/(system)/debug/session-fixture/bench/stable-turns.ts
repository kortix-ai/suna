/**
 * Keep a turn's OBJECT identity when its contents have not changed.
 *
 * `groupMessagesIntoTurns` allocates a fresh `{ userMessage, assistantMessages }`
 * for every turn on every call, and it is called on every streaming frame
 * because `messages` is rebuilt per frame. So a fifty-turn session hands React
 * fifty new `turn` objects ~60 times a second, of which at most ONE has actually
 * changed.
 *
 * That single fact is what makes the whole chat expensive. `turn` is the
 * dependency of nearly every `useMemo` inside a turn — `allParts` first, and
 * then the ~28 memos derived from it — so a new identity invalidates all of
 * them, for every turn, every frame. No memo boundary on the turn component can
 * hold while its main prop is new each time.
 *
 * Comparing element-wise and reusing the previous object fixes it at the source:
 * the streaming turn gets a new identity (it really did change), and every
 * settled turn keeps the one it had, so both its `React.memo` and its entire
 * memo cascade hold.
 *
 * This lives in the host rather than in `groupMessagesIntoTurns` because it is a
 * rendering concern — the grouping itself is correct, it just cannot know that
 * React cares about identity.
 *
 * No React import: this is a pure function, and it is unit-tested as one.
 */

interface MessageLike {
  info: unknown;
  parts: unknown;
}

interface TurnLike {
  userMessage: MessageLike;
  assistantMessages: ReadonlyArray<MessageLike>;
}

/**
 * Messages are compared by their CONTENTS, not by their wrapper.
 *
 * This is the subtle half, and getting it wrong makes the whole module a no-op
 * that still typechecks and still passes its tests. `buildSessionMessages`
 * rebuilds `{ info, parts }` for EVERY message whenever any one message's parts
 * change (`packages/sdk/src/browser/stores/sync-store.ts`) — the `info` and the
 * `parts` array keep their identities, but the object holding them does not. So
 * `a === b` on the wrapper is false for every message on every frame, and a
 * turn built from them would always look changed.
 *
 * Two reference checks per message get the real answer, and reusing the older
 * wrapper is sound because the two are identical in content by construction.
 */
function sameMessage(a: MessageLike, b: MessageLike): boolean {
  return a === b || (a.info === b.info && a.parts === b.parts);
}

function sameTurn(a: TurnLike, b: TurnLike): boolean {
  if (a === b) return true;
  if (!sameMessage(a.userMessage, b.userMessage)) return false;
  if (a.assistantMessages.length !== b.assistantMessages.length) return false;
  for (let i = 0; i < a.assistantMessages.length; i++) {
    if (!sameMessage(a.assistantMessages[i], b.assistantMessages[i])) return false;
  }
  return true;
}

/**
 * `next` with every unchanged turn swapped back to its `prev` object.
 *
 * Returns `prev` itself when nothing changed at all, so the array identity is
 * stable too and a `useMemo` keyed on it holds.
 *
 * Idempotent by construction — `stabilizeTurns(raw, stabilizeTurns(raw, p))`
 * returns the same objects again — which is what makes it safe to run during
 * render under StrictMode's double invocation.
 */
export function stabilizeTurns<T extends TurnLike>(next: T[], prev: T[]): T[] {
  if (next === prev) return prev;

  let changed = next.length !== prev.length;
  const out: T[] = new Array(next.length);

  for (let i = 0; i < next.length; i++) {
    const before = prev[i];
    // Turns are appended, never reordered, so index alignment is the right
    // comparison — and it is what keeps this O(n) instead of O(n²).
    if (before && sameTurn(next[i], before)) {
      out[i] = before;
    } else {
      out[i] = next[i];
      changed = true;
    }
  }

  return changed ? out : prev;
}
