'use client';

/**
 * A turn's outcomes, rendered in its footer.
 *
 * ALWAYS VISIBLE, unlike the Copy / turn-meta bar beside it which reveals on
 * hover. A hidden record of a schedule the agent created is a trust bug: the
 * whole point of the card is that a durable side effect cannot happen quietly.
 *
 * Capped at four. A long tool-heavy turn can produce a lot, and a footer that
 * outgrows its response has inverted the page. The overflow count says so
 * ("N more in this session") — the session summary strip (`SessionOutcomeSummary`)
 * is a one-line sentence, not a second place the overflow cards render.
 */

import { ItemGroup } from '@/components/ui/item';

import { OutcomeCard } from './outcome-card';
import type { Outcome } from './outcome-types';
import { useOutcomeOpen, useTurnOutcomes } from './session-outcomes-provider';

export const MAX_VISIBLE_OUTCOMES = 4;

/** Pure, so the cap is testable without a DOM. */
export function visibleOutcomes(outcomes: Outcome[]): { shown: Outcome[]; overflow: number } {
  if (outcomes.length <= MAX_VISIBLE_OUTCOMES) return { shown: outcomes, overflow: 0 };
  return {
    shown: outcomes.slice(0, MAX_VISIBLE_OUTCOMES),
    overflow: outcomes.length - MAX_VISIBLE_OUTCOMES,
  };
}

export function TurnOutcomes({ turnKey }: { turnKey: string }) {
  const outcomes = useTurnOutcomes(turnKey);
  const onOpen = useOutcomeOpen();
  const { shown, overflow } = visibleOutcomes(outcomes);

  // No outcomes, no footer. The overwhelming majority of turns take this path,
  // so it stays the cheapest one — no wrapper, no group, no separator.
  if (shown.length === 0) return null;

  return (
    <ItemGroup className="mt-3 gap-1.5" data-testid="turn-outcomes">
      {shown.map((outcome, index) => (
        <OutcomeCard key={outcome.id} outcome={outcome} index={index} onOpen={onOpen} />
      ))}
      {overflow > 0 ? (
        <p className="text-muted-foreground px-1 text-xs">{overflow} more in this session</p>
      ) : null}
    </ItemGroup>
  );
}
