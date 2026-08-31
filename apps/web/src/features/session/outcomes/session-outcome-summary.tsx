'use client';

/**
 * What this session produced, in one strip.
 *
 * Answers "what did the agent actually do?" without re-reading two hundred
 * messages — and it is the natural thing to share and the natural thing to
 * carry into a resumed session.
 *
 * A SENTENCE, not cards: the cards already render in each turn's own footer
 * (`TurnOutcomes`). Rendering the same `OutcomeCard` list here duplicated
 * every card on screen — identical to the one in its turn's footer — and had
 * no cap, so a long session stacked every outcome above the first user
 * message of a bottom-anchored transcript. See the design doc,
 * `docs/superpowers/specs/2026-08-31-turn-outcomes-design.md:211-214`.
 *
 * No new data: the same provider the footer cards read. A rollup that fetched
 * its own list could disagree with the cards below it, which is exactly the
 * failure `useSessionChanges` was written to prevent for the Changes badge.
 */

import type { Outcome } from './outcome-types';
import { outcomeCountLabel } from './outcome-vocabulary';
import { useAllOutcomes } from './session-outcomes-provider';

/** Exported for test — a heading with no outcomes is nothing, not "0 outcomes". */
export function SummaryHeading({ outcomes }: { outcomes: Outcome[] }) {
  const label = outcomeCountLabel(outcomes);
  if (!label) return null;
  return <p className="text-muted-foreground px-1 text-xs">This session: {label}</p>;
}

export function SessionOutcomeSummary() {
  const outcomes = useAllOutcomes();
  if (outcomes.length === 0) return null;

  return (
    <section className="mb-4" data-testid="session-outcome-summary">
      <SummaryHeading outcomes={outcomes} />
    </section>
  );
}
