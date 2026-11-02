'use client';

import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';

/**
 * The way into the sub-agent's own session, pinned to the right edge of the row.
 *
 * It used to be a ghost `Button` at the BOTTOM of the disclosure body, and that
 * was wrong twice over. It sat at the body's left margin — the chain's icon
 * gutter — so it read as one more step in the sub-agent's list rather than as
 * an action on the agent. And it was reachable only by expanding the row, which
 * is backwards for a sub-agent that has not produced a step yet: that is the
 * one moment the full view is the ONLY thing there is to look at.
 *
 * A `span role="button"`, not a `<button>`. This node renders inside the
 * disclosure's trigger, and `DisclosureTrigger` clones that trigger into its own
 * `role="button"` element — a button nested in a button is invalid HTML. The
 * subtitle link in `InlineTriggerTitle` is the same shape for the same reason.
 * Both activation paths `stopPropagation` so reaching the full view does not
 * also toggle the row underneath it.
 *
 * Visible label "Full view", accessible name "Open full view". The row already
 * carries a title plus a live subtitle that has to truncate, so the right edge
 * gets the two words that matter; the longer name rides on `aria-label` and
 * `title`, and it CONTAINS the visible text, so WCAG 2.5.3 (Label in Name)
 * holds.
 *
 * Always visible, never hover-revealed: a hover-only affordance does not exist
 * on touch, and this is the only route to a running sub-agent's full transcript.
 */
export function FullViewAction({ onOpen }: { onOpen: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={tI18nComplete.raw('text229fbeec6b2f')}
      title={tI18nComplete.raw('text229fbeec6b2f')}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
      className={cn(
        'text-muted-foreground hover:text-foreground',
        'flex cursor-pointer items-center gap-1 whitespace-nowrap',
        'underline-offset-2 transition-colors hover:underline',
      )}
    >
      {tI18nComplete.raw('textdcc839a4015c')}
    </span>
  );
}

