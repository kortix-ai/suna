/**
 * Which turn does an outcome belong to?
 *
 * The rule: the turn whose [startedAt, endedAt] span contains the outcome's
 * timestamp. Nothing is ever DROPPED — an outcome before the first turn anchors
 * to the first, and one after the last anchors to the last. That last case is
 * the common one, not an edge case: a change request is written moments after
 * the turn's final message, so a strict containment test would orphan almost
 * every card.
 */

import type { Outcome } from './outcome-types';

export interface TurnSpan {
  /** The same key `session-chat.tsx` renders the turn under. */
  key: string;
  startedAt: number | null;
  endedAt: number | null;
}

export function anchorOutcomes(outcomes: Outcome[], spans: TurnSpan[]): Map<string, Outcome[]> {
  const byTurn = new Map<string, Outcome[]>();
  if (spans.length === 0) return byTurn;

  const ordered = [...outcomes].sort((a, b) => a.at - b.at);

  for (const item of ordered) {
    // The span with the LATEST start at or before this outcome — chosen by
    // comparing `startedAt`, never by iteration order.
    //
    // The obvious loop ("keep overwriting `target` whenever a span qualifies")
    // is only correct while `spans` happens to arrive in ascending order, and
    // nothing in this module's contract requires that. A caller that built its
    // list from anything but a chronological walk would silently anchor an
    // outcome to whichever qualifying turn it listed LAST — a bug with no
    // symptom until someone reorders a list two files away.
    //
    // `best` starts at -Infinity so the first qualifying span always wins it,
    // and a null start is skipped rather than treated as 0. A tie keeps the
    // earliest-declared span, which only matters for two turns claiming the
    // same millisecond.
    let target = spans[0];
    let best = -Infinity;
    for (const span of spans) {
      if (span.startedAt === null) continue;
      if (span.startedAt <= item.at && span.startedAt > best) {
        best = span.startedAt;
        target = span;
      }
    }
    const list = byTurn.get(target.key);
    if (list) list.push(item);
    else byTurn.set(target.key, [item]);
  }

  return byTurn;
}

/**
 * Do two outcome lists carry the same content?
 *
 * Compares `(id, at)` per entry, NOT id alone. An id alone is not a sound
 * identity: a change request keeps `cr:<id>` while its status moves open →
 * merged, so an id-only comparison would report "unchanged", hand back the
 * previous array, and freeze a stale status on screen.
 *
 * Used to hold the provider's context value flat across a stream, so a turn
 * that is merely re-rendering does not re-render every card beneath it.
 */
export function sameOutcomes(prev: Outcome[], next: Outcome[]): boolean {
  if (prev.length !== next.length) return false;
  return prev.every((p, i) => p.id === next[i].id && p.at === next[i].at);
}
