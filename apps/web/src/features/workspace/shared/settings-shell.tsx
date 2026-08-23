'use client';

/**
 * `SettingsShell` — the two-column settings layout, defined once.
 *
 * ## Why this file exists
 *
 * The account hub (`app/(app)/accounts/[id]/page.tsx`) and the project's
 * Settings tab (`capabilities/project-settings/project-settings-page.tsx`) are
 * the same screen: a narrow rail of sections on the left, the selected section
 * on the right. They were built twice, and every difference between the two
 * builds was a bug someone had to spot:
 *
 *  - The project page's grid spanned the FULL width while its content pane
 *    centred itself with `mx-auto`. The rail was pinned to the far left edge
 *    and ~260px of dead space opened between it and the content it selects —
 *    the two columns did not read as one layout. The account page centres rail
 *    AND content together inside one `max-w-6xl` container, so the gap between
 *    them is exactly `gap-12` and nothing else.
 *  - The project rail was its own `overflow-y-auto` scroller beside a second
 *    one. The account rail is `lg:sticky lg:top-8` inside the page's single
 *    scroller.
 *  - The project page carried a whole separate `isMobile` branch — a
 *    `FadedScrollArea` wrapping a horizontal `Tabs` strip. The account rail
 *    already collapses to a horizontal chip row below `lg` with plain CSS, no
 *    branch and no second component.
 *
 * One shell now. Both pages pass groups and get identical chrome; a change to
 * the layout has one place to be made.
 *
 * ## What it does NOT own
 *
 * **The column, the padding and the scroll container.** Hosts differ there and
 * must. The account hub is a full-width page: it centres itself in
 * `max-w-6xl` and scrolls inside `accounts/layout.tsx`'s `px-mobile py-10
 * sm:py-12` main. The project page sits beside the app sidebar under
 * `(capabilities)/layout.tsx`'s `h-svh … overflow-hidden` box that pins the
 * tab bar, so it opens its own single `overflow-y-auto` and uses
 * `CapabilityPageShell`'s column verbatim — `mx-auto w-full max-w-5xl px-4
 * py-10 pb-20 lg:py-14` — because Models, Connectors, Agents, Skills, Triggers
 * and Secrets all draw that exact column and Settings is the seventh tab on
 * the same bar. A shell that hardcoded ONE column put the rail hard against
 * the sidebar's edge with no gutter at all.
 *
 * Two rules follow, and both are load-bearing:
 *
 *  - Vertical padding belongs on a child of the scroller, never on the
 *    scroller itself. A scroll container's own padding insets the rectangle a
 *    sticky descendant measures `top` against, so `py-10` on the scroller made
 *    the rail's `lg:top-8` push it 30px BELOW the heading beside it — at rest,
 *    with nothing scrolled. Measured: aside top 117 vs heading top 87, and 87
 *    with `top: 0`. The account hub never hit this; its scrollport is the
 *    window, which has no padding to inset.
 *  - `lg:sticky` resolves against whichever ancestor is the nearest scroll
 *    container, which is why the rail behaves the same in both hosts.
 *
 * **The pane heading.** The account hub renders `paneMeta`; project panes
 * render their own `SettingsTabHeader`. Both are just children here.
 */

import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import { m, useReducedMotion } from 'motion/react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** One rail row. `href` makes it a link; otherwise it is a button. */
export interface SettingsRailItem {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /**
   * Present → a real `<Link prefetch>`, so the row can be middle-clicked,
   * copied and landed on directly. The project page's sections are URL state
   * (`?section=`) and must be links; the account hub's `navigate()` rewrites
   * the query in place and stays a button.
   */
  href?: string;
  /** Trailing count badge. Rendered only when > 0. */
  count?: number;
  /** Trailing attention dot. Ignored when `count` is showing. */
  attention?: boolean;
}

export interface SettingsRailGroup {
  /** Uppercase group heading. Omit for a group that needs no label. */
  label?: string;
  items: SettingsRailItem[];
}

/**
 * The rail. Below `lg` it is a horizontal scrolling chip row; at `lg` and up a
 * sticky column of full-width rows.
 *
 * `groups` arrives ALREADY filtered — a host drops the rows a caller cannot
 * see, and drops any group that empties out. Indexing the filtered list is the
 * one deliberate difference from the account page's previous inline version,
 * which indexed the unfiltered one and so drew a leading 16px spacer above the
 * first visible group whenever the group before it was entirely hidden.
 */
export function SettingsRail({
  groups,
  activeId,
  onSelect,
  ariaLabel,
  identity,
}: {
  groups: SettingsRailGroup[];
  activeId: string;
  /** Called for button rows. Link rows navigate themselves. */
  onSelect?: (id: string) => void;
  ariaLabel: string;
  /**
   * Avatar + name block above the nav. The account hub passes one — it is the
   * only place that page names the account. The project page passes none: the
   * app sidebar already carries the project's avatar and name two columns to
   * the left, at the same size, so a second copy just says it twice.
   */
  identity?: ReactNode;
}) {
  return (
    <aside className="mb-6 space-y-4 self-start lg:sticky lg:top-8 lg:mb-0">
      {identity}
      <nav
        aria-label={ariaLabel}
        className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0"
      >
        {groups.map((group, gi) => (
          <div key={group.label ?? gi} className="contents lg:block lg:space-y-0.5">
            {gi > 0 ? <div className="hidden lg:block lg:h-4" aria-hidden /> : null}
            {group.label ? (
              // Same label dialect as the project sidebar's group headings.
              // Hidden on the mobile horizontal strip — there the items flow
              // as one row of chips.
              <p className="text-muted-foreground/60 hidden px-2.5 pb-1 text-xs font-medium tracking-wider uppercase lg:block">
                {group.label}
              </p>
            ) : null}
            {group.items.map((item) => (
              <SettingsRailRow
                key={item.id}
                item={item}
                active={item.id === activeId}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/**
 * One row, in the one dialect: `h-8`, `rounded-sm`, `px-2.5`, `gap-2.5`, a
 * `size-4` icon, a `bg-primary/[0.06]` active fill and `hover:bg-accent`
 * otherwise. Link and button render the SAME class string — a row that is a
 * link must be indistinguishable from a row that is not.
 */
function SettingsRailRow({
  item,
  active,
  onSelect,
}: {
  item: SettingsRailItem;
  active: boolean;
  onSelect?: (id: string) => void;
}) {
  const Icon = item.icon;
  const showCount = item.count != null && item.count > 0;
  const className = cn(
    'flex h-8 shrink-0 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-sm whitespace-nowrap transition-colors lg:w-full',
    active
      ? 'bg-primary/[0.06] text-foreground font-medium'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  );
  const body = (
    <>
      <Icon className="size-4 shrink-0" />
      <span className="lg:truncate">{item.label}</span>
      {showCount ? (
        <Badge variant="kortix" size="xs" className="tabular-nums lg:ml-auto">
          {item.count}
        </Badge>
      ) : item.attention ? (
        <span aria-hidden className="bg-kortix-orange size-1.5 shrink-0 rounded-full lg:ml-auto" />
      ) : null}
    </>
  );

  if (item.href) {
    return (
      <Link
        href={item.href}
        prefetch
        aria-current={active ? 'page' : undefined}
        className={className}
      >
        {body}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect?.(item.id)}
      aria-current={active ? 'page' : undefined}
      className={className}
    >
      {body}
    </button>
  );
}

/**
 * The two-column container: rail and content centred TOGETHER inside one
 * `max-w-6xl`, `gap-12` apart at `lg` and stacked below it.
 *
 * The content pane remounts on `activeKey` and rises 4px over 200ms —
 * opacity-only under reduced motion.
 */
export function SettingsShell({
  rail,
  activeKey,
  contentClassName,
  children,
}: {
  rail: ReactNode;
  /** Remount key for the content pane — the active section's id. */
  activeKey: string;
  /** Widens or narrows the content pane. Defaults to `max-w-3xl`. */
  contentClassName?: string;
  children: ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion();
  return (
    /* The GRID only. The host owns the column it sits in — see "The column,
       the padding and the scroll container" above. */
    <div className="lg:grid lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-12">
      {rail}
      <m.div
        key={activeKey}
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
        className={cn('min-w-0 max-w-3xl', contentClassName)}
      >
        {children}
      </m.div>
    </div>
  );
}
