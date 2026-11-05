'use client';

// Chrome shared by the session list (`project-session-list.tsx`) and its group
// sections (`session-group-sections.tsx`): one `⋯` box, one row height, one
// page size, one Load more.

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';

/** The one `⋯` box. All three menus in the session list — the `Sessions` header, every
 *  section header, and every session row — render `Button variant="ghost"
 *  size="icon-xs"` with THIS class, so the glyph sits on a single vertical
 *  axis at every level of the tree.
 *
 *  The geometry, given every row is `px-2` inside the same column: the trigger
 *  is flush to the right edge of that padded box, so its 24px square spans
 *  `[W-32, W-8]` and the 16px glyph inside spans `[W-28, W-12]` — identical for
 *  all three, at any sidebar width.
 *
 *  Do NOT rebuild this from `SidebarMenuButton`. That primitive's base carries
 *  `p-2 w-full h-8 gap-2 overflow-hidden`; `size-6` only beats `w-full`/`h-8`
 *  through tailwind-merge, and `p-2` survives outright — leaving a 16px icon
 *  overflowing an 8px content box, centered by coincidence rather than by
 *  layout, with a different hover fill than the other two. */
export const SESSION_MENU_TRIGGER_CLASS = cn(
  'text-muted-foreground shrink-0 transition-none',
  // An OPAQUE hover fill, and the reason it has to be opaque:
  //
  // `variant="ghost"` hovers to `bg-foreground/10`. `background-color` is one
  // property, so on the row trigger that 10% tint did not sit on top of the
  // `bg-(--session-row-surface)` mask — it REPLACED it. The mask exists to hide
  // the truncated session title running underneath the glyph, so hovering
  // punched a translucent hole in it and the title bled through: the washed-out
  // grey square in the bug report, with a muted `⋯` floating in it.
  //
  // `sidebar-row-control` is one opaque step above the row's own fill
  // (`--sidebar-row`) on hover, in both themes. The square reads as lifted, stays a solid
  // mask, and needs no pseudo-element to stack a tint above a fill.
  'hover:bg-sidebar-row-control data-[state=open]:bg-sidebar-row-control',
  // Full contrast once the pointer is on it — the glyph is a control now, not a
  // marker.
  'hover:text-foreground data-[state=open]:text-foreground',
);

/** Every row that can carry a `⋯` is this tall, so the trigger's 24px square is
 *  centered in an identical 32px line at all three levels. */
export const SESSION_ROW_HEIGHT_CLASS = 'h-8';

/** Rows per page of an expanded parent, and per page of the Shared,
 *  Automated and group sections. */
export const SIDEBAR_PAGE_SIZE = 20;

export function ShowMoreButton({
  loading,
  failed,
  label,
  onClick,
}: {
  loading: boolean;
  failed: boolean;
  label: string;
  onClick: () => void;
}) {
  const t = useTranslations('sidebar');
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground hover:text-foreground h-8 w-full justify-start px-2 text-xs"
      disabled={loading}
      onClick={onClick}
    >
      {/* A failed page keeps the rows above it; the button is the retry. */}
      {loading ? t('loadingMore') : failed ? t('retry') : label}
    </Button>
  );
}
