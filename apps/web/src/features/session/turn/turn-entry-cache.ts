/**
 * Per-turn memoization for the transcript's derived data.
 *
 * ## The problem this solves
 *
 * The transcript needs, per turn, its `SessionTurnProps` and its
 * `TurnRowInputs` — and it needs them for EVERY turn, before rendering any, in
 * order to build the flat row list. Neither can come from a hook, because hooks
 * cannot run in a loop.
 *
 * Building them in one `useMemo` over `turns` looks right and is quietly
 * quadratic. `groupMessagesIntoTurns` returns a NEW ARRAY on every streamed
 * token (it has to — the last turn changed), so a `useMemo` keyed on `turns`
 * re-runs, and rebuilding the map recomputes `computeTurnRowInputs` for every
 * turn — a scan of every part in the thread. Per token.
 *
 * At one to three turns that is invisible. On a long thread it is the same
 * class of bug as the one windowing just fixed: work that grows with the
 * conversation instead of with what changed.
 *
 * ## Why turn identity is a sound cache key
 *
 * `groupMessagesIntoTurns(messages, previous)` hands back the PREVIOUS turn
 * object for any turn whose messages are all reference-unchanged. So an
 * unchanged `turn` reference is a real guarantee that nothing in that turn
 * moved — not a heuristic.
 *
 * ## Why `sessionStatus` and `isBusy` are excluded for non-last turns
 *
 * A turn's `working` flag is
 * `getWorkingState(sessionStatus, isLastUserTurn) || (isLastUserTurn && isBusy)`,
 * and `getWorkingState` returns false immediately when `isLast` is false
 * (packages/sdk/src/core/turns/state.ts:78). So for a non-last turn both terms
 * are false regardless of either signal — and those two are exactly the values
 * that change on every tick while the agent is working.
 *
 * Comparing them anyway would defeat the cache for the entire thread on every
 * status tick, which is most of what this module exists to prevent.
 *
 * Pure: no React, no DOM.
 */

export interface TurnEntryDeps {
  /** The turn object. Identity is the primary signal — see the note above. */
  turn: unknown;
  isLastUserTurn: boolean;
  isPlanAnchor: boolean;
  isCompaction: boolean;
  /** Changes for turn 0 when older history is prepended. */
  isFirstTurn: boolean;
  permissions: unknown;
  questions: unknown;
  /**
   * Everything the turn renders with that is NOT per-turn — session id, agent
   * names, providers, commands, the reply handlers, the rewind gate.
   *
   * Bundled into one object so a single `Object.is` covers all of it. The
   * caller memoizes the bundle; if any member changes, every entry rebuilds,
   * which is correct because every turn renders with it.
   */
  shared: unknown;
  /** Compared ONLY for the last user turn. */
  sessionStatus: unknown;
  /** Compared ONLY for the last user turn. */
  isBusy: boolean;
}

export function turnEntryDepsEqual(a: TurnEntryDeps, b: TurnEntryDeps): boolean {
  if (
    !Object.is(a.turn, b.turn) ||
    a.isLastUserTurn !== b.isLastUserTurn ||
    a.isPlanAnchor !== b.isPlanAnchor ||
    a.isCompaction !== b.isCompaction ||
    a.isFirstTurn !== b.isFirstTurn ||
    !Object.is(a.permissions, b.permissions) ||
    !Object.is(a.questions, b.questions) ||
    !Object.is(a.shared, b.shared)
  ) {
    return false;
  }
  // Both are non-last (the flags are already known equal), so neither entry can
  // observe these two.
  if (!a.isLastUserTurn) return true;
  return Object.is(a.sessionStatus, b.sessionStatus) && a.isBusy === b.isBusy;
}

export interface TurnEntryCacheEntry<E> {
  deps: TurnEntryDeps;
  entry: E;
}

export interface ReconcileResult<E> {
  /** Entry per turn id, in turn order. */
  entries: Map<string, E>;
  /** Feed back in on the next pass. Contains only the turns still present. */
  cache: Map<string, TurnEntryCacheEntry<E>>;
}

/**
 * Build one entry per turn, reusing the previous entry whenever that turn's
 * dependencies are unchanged.
 *
 * The returned `cache` is rebuilt from the current turn list rather than
 * mutated, so turns removed by a rewind are evicted instead of accumulating
 * for the life of the session.
 */
export function reconcileTurnEntries<T, E>(
  turns: readonly T[],
  getId: (turn: T, index: number) => string,
  getDeps: (turn: T, index: number) => TurnEntryDeps,
  create: (deps: TurnEntryDeps, turn: T, index: number) => E,
  previous: ReadonlyMap<string, TurnEntryCacheEntry<E>>,
): ReconcileResult<E> {
  const entries = new Map<string, E>();
  const cache = new Map<string, TurnEntryCacheEntry<E>>();

  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    const id = getId(turn, index);
    const deps = getDeps(turn, index);

    const prior = previous.get(id);
    // Reuse the previous ENTRY OBJECT, not just skip the work: downstream
    // memos and React.memo compare it by identity.
    const entry =
      prior && turnEntryDepsEqual(prior.deps, deps) ? prior.entry : create(deps, turn, index);

    entries.set(id, entry);
    cache.set(id, { deps, entry });
  }

  return { entries, cache };
}
