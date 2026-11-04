'use client';

import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';
import Hint from '../../primitives/hint';

/**
 * A message body's type: the app's default `text-sm` at 500. A row's markdown
 * answer is set to `text-sm` too (`MessageRow`'s body), so a prompt, its answer
 * and the channel row of the same prompt read at one size and weight. The 600
 * name above it, at the same size, carries the row's hierarchy.
 */
export const MESSAGE_TEXT_CLASS = 'text-foreground text-sm leading-relaxed font-medium';

/**
 * One message in a channel or a thread: the author's 36px avatar in a fixed
 * gutter, the name and the time on one baseline, the body under them. The
 * channel timeline and the thread panel draw every row with it, so a reply
 * reads the same as the message it answers.
 *
 * A `compact` row continues the author's previous message: no avatar, no
 * name. Its time shows in the gutter on hover, inside the gutter's own width,
 * so it never touches the body.
 *
 * The hover fill is instant: a dense list re-hovers too often to animate.
 */
export function MessageRow({
  avatar,
  name,
  time,
  compact = false,
  selected = false,
  toolbar,
  className,
  children,
}: {
  /** The 36px avatar: `UserAvatar size="lg"` for a person, `EntityAvatar size="lg"` for an agent. */
  avatar?: ReactNode;
  name?: ReactNode;
  /** `label` beside the name; `gutter` (a shorter form) in a compact row's gutter; `title`, the full date, in the hover hint. */
  time?: { iso: string; label: string; gutter?: string; title: string } | null;
  compact?: boolean;
  selected?: boolean;
  /** The row's actions, floating at its top-right on hover or keyboard focus. */
  toolbar?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="message-row"
      className={cn(
        'group/message hover:bg-hover relative flex gap-2 px-5',
        // Baseline: a compact row's gutter time sits on the body's first line.
        compact ? 'items-baseline py-0.5' : 'items-start pt-2 pb-1.5',
        selected && 'bg-active hover:bg-active',
        className,
      )}
    >
      {/* `w-10` is the `lg` avatar's own width: every body starts on one edge.
          A person's photo sits `rounded-md` with no hairline: in a row the
          face is the edge, and the ring read as a frame around it. */}
      <div className="w-10 shrink-0 [&_[data-slot=avatar]]:rounded-md [&_[data-slot=avatar]]:after:hidden">
        {compact ? (
          time ? (
            <Hint label={time.title} side="top" sideOffset={6}>
              <time
                dateTime={time.iso}
                className="text-muted-foreground invisible block cursor-default text-right text-xs font-normal whitespace-nowrap tabular-nums group-focus-within/message:visible group-hover/message:visible"
              >
                {time.gutter ?? time.label}
              </time>
            </Hint>
          ) : null
        ) : (
          avatar
        )}
      </div>
      {/* The markdown renderer sets prose at 15px for the session view;
          in a row it reads at the row's `text-sm`. */}
      <div className="min-w-0 flex-1 [&_.kortix-markdown]:text-sm">
        {compact ? null : (
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-foreground truncate text-sm font-semibold">{name}</span>
            {time ? (
              // The full date in the app's tooltip, not the browser's `title`.
              <Hint label={time.title} side="top" sideOffset={6}>
                <time dateTime={time.iso} className="text-muted-foreground shrink-0 cursor-default text-xs font-normal tabular-nums">
                  {time.label}
                </time>
              </Hint>
            ) : null}
          </div>
        )}
        {children}
      </div>
      {toolbar ? <RowToolbar>{toolbar}</RowToolbar> : null}
    </div>
  );
}

/**
 * The floating action group at a row's top-right. Transparent, not unmounted,
 * so Tab reaches its buttons and their focus reveals it. `p-[2px]`: the group
 * is `rounded-lg` (10px), so 2px of inset gives the `rounded-md` (8px)
 * buttons concentric corners. Its buttons are `icon-sm` (h-7), so the group is
 * ~32px tall; `-top-3.5` sits it on the row's top edge, half above it.
 *
 * A thread's first message is the one row whose overhang is cut off (its turn
 * paints with `content-visibility: auto`, which clips to the turn): that row
 * moves the group inside with `[&_[data-slot=row-toolbar]]:top-0.5`.
 */
export function RowToolbar({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="row-toolbar"
      className="bg-popover pointer-events-none absolute -top-3.5 right-5 z-10 flex items-center rounded-lg border p-[2px] opacity-0 shadow-md group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100"
    >
      {children}
    </div>
  );
}
