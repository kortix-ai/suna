'use client';

import Hint from '@/components/ui/hint';
import { fullDate } from '@/lib/utils/date';
import { agoLabel } from './subproject-runs';

/**
 * The relative-time column shared by every subproject-run list: the project-home
 * preview, the run index, and one subproject's run history.
 *
 * ONE implementation because all three are the same column with the same two
 * requirements — a fixed width so the status circles align down the list, and
 * one line so no row grows taller than its neighbours. It was duplicated as an
 * inline `w-12` span in two files, and both wrapped.
 *
 * `w-18` and `whitespace-nowrap`, not `w-12`: this app sets `--spacing` to
 * `0.23rem`, so `w-12` was 44px — narrower than `21m ago` (46px at the 13px
 * `--text-xs`), which wrapped to two lines, grew the row, and pushed the status
 * circles out of alignment with the rows above and below. `w-18` is 66px, which
 * clears the widest label `agoLabel` can emit (`11mo ago`, 61px measured) with
 * 5px to spare; `just now` is 54px. The nowrap makes the one-line rule a
 * guarantee rather than a measurement that happens to hold.
 */
const AGO_COLUMN_CLASS =
  'text-muted-foreground/60 w-18 shrink-0 text-right text-xs whitespace-nowrap tabular-nums';

/**
 * A subproject run's age, with the instant it stands for on hover.
 *
 * The number alone is ambiguous. On a row whose circles each carry their own
 * age, "21m ago" could plausibly be the newest circle's age, the oldest's, or
 * the subproject's install date — so the tooltip NAMES what is being measured, and
 * adds the absolute instant, which is what a reader needs to correlate a run
 * with anything outside this list.
 *
 * `side="top"`: this column sits at a row's right edge, hard against the 52rem
 * hero box, so a right-side tooltip would open off the box.
 *
 * With no timestamp there is nothing to date, so the em dash gets no tooltip —
 * a hint over "—" would describe a run that never happened.
 */
export function SubprojectRunAge({
  iso,
  now,
  heading,
}: {
  iso: string | null;
  /** One clock for the whole list, so no two rows disagree by a minute. */
  now?: number;
  /** What the age measures, e.g. `Time since last run`. */
  heading: string;
}) {
  const ago = agoLabel(iso, now);

  if (!iso) return <span className={AGO_COLUMN_CLASS}>{ago}</span>;

  const exact = fullDate(iso);

  return (
    <Hint
      side="top"
      align="end"
      alignOffset={0}
      label={
        <span className="block text-xs">
          <span className="font-medium">{heading}</span>
          {/* Tooltip ground is `bg-foreground`, so the secondary line is
              `text-background/60` — `text-muted-foreground` would be muted
              against the WRONG ground. Same rule as the run circles. */}
          <span className="text-background/60 mt-0.5 block tabular-nums">{exact}</span>
        </span>
      }
    >
      {/* `aria-label` rather than a tab stop: five rows would mean five extra
          stops through non-interactive text, and the label carries the same two
          facts the tooltip does. */}
      <span className={AGO_COLUMN_CLASS} aria-label={`${heading}: ${ago}, ${exact}`}>
        {ago}
      </span>
    </Hint>
  );
}
