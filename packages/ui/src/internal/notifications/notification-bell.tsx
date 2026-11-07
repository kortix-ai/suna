/**
 * `BellMark`: a glyph with a count disc off its bottom-right corner, in the
 * toast's badge-glow style. The account pages' Inbox button (KRTX-1742) and the
 * project home's access-requests control draw their counts with it. The inbox
 * itself is a page:
 * `notification-inbox.tsx`.
 */

import { cn } from '../lib/utils';
import { BellIcon } from '@phosphor-icons/react';
import { badgeCount } from './notification-rows';

/**
 * The toast's `REFLECTION_MASK` scaled from its 20px icon to the 16px bell
 * (16px → 12px), centred on the glyph's bottom-right corner where the count
 * sits. At full size it would tint the whole bell.
 */
export const BELL_REFLECTION_MASK = 'radial-gradient(circle 12px at 100% 100%, #000 35%, transparent 100%)';

/**
 * The bell (Paper B12 in the toast's badge-glow style): the glyph muted, then
 * again in the badge's colour under `BELL_REFLECTION_MASK`, so the
 * colour reaches in from the corner the count sits on, as `EntityTile` in
 * `components/ui/toast.tsx` and `TriggerTile` draw it. Yellow when something
 * waits on the person (the Needs you tab), blue otherwise.
 */
export function BellMark({
  count,
  needsYou,
  surface = 'bg-background',
  icon: Glyph = BellIcon,
}: {
  count: number;
  needsYou: boolean;
  surface?: 'bg-background' | 'bg-sidebar';
  /** The glyph under the count: the bell, or another control's own mark. */
  icon?: typeof BellIcon;
}) {
  const tone = needsYou
    ? { reflection: 'text-kortix-yellow', disc: 'bg-kortix-yellow' }
    : { reflection: 'text-kortix-blue', disc: 'bg-kortix-blue' };
  return (
    <span className="relative size-4 shrink-0">
      <Glyph className="size-4" />
      {count > 0 ? (
        <>
          <Glyph
            aria-hidden
            className={cn('absolute inset-0 size-4', tone.reflection)}
            style={{ maskImage: BELL_REFLECTION_MASK, WebkitMaskImage: BELL_REFLECTION_MASK }}
          />
          {/* Off the glyph's corner, so the bell stays whole. The disc's own
              ring paints the surface behind the button, so it reads as cut out. */}
          <span
            aria-hidden
            className={cn('absolute -right-2.5 -bottom-2 flex rounded-full p-px', surface)}
          >
            <span
              data-slot="bell-count"
              className={cn(
                'text-background flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] leading-none font-semibold tabular-nums', // audit:allow a numeral in a 13px disc on a 16px glyph; no type rung fits
                tone.disc,
              )}
            >
              {badgeCount(count)}
            </span>
          </span>
        </>
      ) : null}
    </span>
  );
}
