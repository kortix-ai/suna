'use client';

import { Kbd } from '@/components/ui/kbd';
import { getFileIcon } from '@/features/project-files';
import { cn } from '@/lib/utils';
import {
  ArrowsClockwiseIcon,
  BrainIcon,
  PaperclipIcon,
  PlugsConnectedIcon,
  PuzzlePieceIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';

import { MenuCard, MenuRow, MenuSectionHeading } from './menu-shell';
import type { SlashRow, SlashSection } from './slash-items';

/**
 * Per-row glyph. Commands are grouped by `Command.source` upstream
 * (`slash-items.ts`'s `groupCommandsBySource`), but the row itself doesn't
 * carry the source, so the heading it was filed under is what selects the
 * icon — the same fact, read from the only place the view can see it.
 */
/**
 * Returns the rendered element, not the component type.
 *
 * The obvious shape — `const Glyph = LOOKUP[id]; return <Glyph/>` — trips the
 * React Compiler's `react-hooks/static-components` rule: it sees a capitalized
 * binding assigned during render and cannot prove the lookup table is a frozen
 * module constant, so it reports a component type that changes identity every
 * render (which would remount the subtree if it were true). Returning elements
 * from a switch keeps every element type statically resolvable, so the rule is
 * satisfied by construction rather than suppressed.
 */
function SlashRowIcon({
  row,
  heading,
  className,
}: {
  row: SlashRow;
  heading: string;
  className?: string;
}) {
  // Per-extension, not one generic file glyph: the palette's file rows are the
  // same files the Outputs and Context cards draw, and those cards use this
  // exact helper (`outputs-card.tsx`, `mention-menu.tsx`). A `.pdf` that looks
  // like a `.pdf` in one surface and a blank page in another reads as two
  // different files. `getFileIcon` returns an ELEMENT, which is also what
  // keeps this switch free of the `static-components` problem below.
  if (row.type === 'file' && row.file) return getFileIcon(row.file.path, { className });
  if (row.type === 'action' && row.action) {
    switch (row.action.id) {
      case 'switch-model':
        return <ArrowsClockwiseIcon className={className} />;
      case 'switch-agent':
        return <RobotIcon className={className} />;
      case 'set-reasoning-effort':
        return <BrainIcon className={className} />;
      case 'attach-file':
        return <PaperclipIcon className={className} />;
      default:
        return <SlidersHorizontalIcon className={className} />;
    }
  }
  if (heading === 'Skills') return <PuzzlePieceIcon className={className} />;
  if (heading === 'MCP') return <PlugsConnectedIcon className={className} />;
  return <TerminalWindowIcon className={className} />;
}

/**
 * The `/` palette.
 *
 * Two panes on desktop — a scrollable row list on the left, a detail pane on
 * the right describing whatever is currently selected. The detail pane is
 * driven entirely by `selectedIndex`, which the controller already owns
 * (`MenuNavState`), so arrowing through the list updates the description with
 * no extra state and no extra render path: the same prop that paints the
 * highlight paints the detail.
 *
 * `onHover` folds the mouse into that same single index. Pointing at a skill,
 * command, or action MAKES it the selection — the highlight moves, the detail
 * pane describes what is under the cursor, and Enter takes what you are
 * pointing at. Without it, hover was a second, weaker highlight that painted a
 * row the pane refused to describe and Enter refused to run.
 *
 * The detail pane is hidden below `sm`. On a phone there is no room for two
 * columns beside a keyboard, and the row list is the part you actually need —
 * so the card degrades to the single column rather than shrinking both panes
 * into uselessness.
 *
 * ## Docked, not floating
 *
 * `w-full` and `mb-2`, with no width of its own: this card is appended into a
 * dock element that `composer.tsx` renders directly above the composer card
 * (see `mount.ts`'s `mountDockedMenu` for the mechanism and the reasoning), so
 * its width IS the composer's width and it sits in normal flow rather than
 * over the page. `mb-2` lives here rather than on the dock so an empty dock —
 * no match, or no menu open — contributes no gap at all: the margin cannot
 * exist without a card to own it.
 *
 * `rounded-lg` (8px) is the cap `menu-shell.tsx` documents for app containers,
 * and it is the same radius the `@` menu uses — the two palettes read as one
 * system rather than two different popovers. It is deliberately NOT the
 * composer card's `rounded-xl`: this card floats above the card, so matching
 * it exactly made the seam between them read as a rendering glitch.
 */
export function SlashMenu({
  sections,
  selectedIndex,
  onSelect,
  onHover,
}: {
  sections: SlashSection[];
  selectedIndex: number;
  onSelect: (row: SlashRow) => void;
  onHover?: (row: SlashRow) => void;
}) {
  // A query that matches nothing keeps the card, with one dead row saying so.
  // Returning `null` made the palette DISAPPEAR mid-word — the user could not
  // tell "no match" from "the menu closed", and one backspace brought it back
  // from nowhere.
  if (!sections.length) {
    return (
      <MenuCard className={cn('mb-2.5 w-full rounded-lg')}>
        <p role="status" className="text-muted-foreground px-3 py-2.5 text-sm">
          No matching command, file, or action
        </p>
      </MenuCard>
    );
  }

  const rows = sections.flatMap((section) =>
    section.rows.map((row) => ({ row, heading: section.heading })),
  );
  const active = rows.find(({ row }) => row.index === selectedIndex) ?? rows[0];

  return (
    <MenuCard className={cn('mb-2.5 flex max-h-96 w-full overflow-hidden rounded-lg shadow-xs')}>
      <div
        role="listbox"
        aria-label="Commands and actions"
        aria-activedescendant={`slash-row-${selectedIndex}`}
        // `-1`, matching `mention-menu.tsx`: focusable for AT, but never a tab
        // stop. Keyboard interaction stays in the composer editor, which
        // proxies arrow/Enter to this listbox — a real tab stop here trapped
        // Tab between the palette and the composer.
        tabIndex={-1}
        className="min-w-0 flex-1 space-y-2 overflow-y-auto p-2"
      >
        {sections.map((section) => (
          <div key={section.heading}>
            {!section.hideHeading && <MenuSectionHeading>{section.heading}</MenuSectionHeading>}
            <div className="space-y-0.5">
              {section.rows.map((row) => (
                <MenuRow
                  key={`${row.type}-${row.name}-${row.index}`}
                  id={`slash-row-${row.index}`}
                  selected={row.index === selectedIndex}
                  onSelect={() => onSelect(row)}
                  onHover={() => onHover?.(row)}
                >
                  <SlashRowIcon
                    row={row}
                    heading={section.heading}
                    className="text-muted-foreground size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
                  {/*
                    The control's current setting — "Switch agent · Orchestrator".
                    Plain muted text, NOT a `kbd`: a `kbd` means "press this",
                    and the agent's name is not a key. It also stays before the
                    hint so the row reads left to right as
                    what-it-does · what-it-is-now · how-to-trigger.

                    `max-w-[8rem] truncate` because this is host data, not a
                    fixed label — a long agent name must shorten itself rather
                    than push the row's own name out of view.
                  */}
                  {row.value && (
                    <span className="text-muted-foreground max-w-[8rem] shrink-0 truncate text-xs">
                      {row.value}
                    </span>
                  )}
                  {row.hint && <Kbd className="shrink-0">{row.hint}</Kbd>}
                </MenuRow>
              ))}
            </div>
          </div>
        ))}
      </div>

      {active && (
        <div className="border-border hidden w-[56%] max-w-[24rem] shrink-0 flex-col overflow-y-auto border-l p-4 sm:flex">
          <div className="flex items-start gap-2.5">
            <SlashRowIcon
              row={active.row}
              heading={active.heading}
              className="text-muted-foreground mt-0.5 size-4 shrink-0"
            />
            <p className="text-foreground min-w-0 flex-1 text-sm font-medium break-words">
              {active.row.name}
            </p>
          </div>
          {active.row.description && (
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed text-pretty">
              {active.row.description}
            </p>
          )}
          <div className="mt-auto flex items-center justify-end gap-2 pt-4">
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <Kbd>↵</Kbd> to use
            </span>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(active.row);
              }}
              className={cn(
                'bg-primary text-primary-foreground rounded-full px-3.5 py-1.5 text-sm font-medium',
                // Named properties, never `transition-all`: `scale` is driven
                // by `active:` and must stay interruptible on its own timeline.
                'cursor-pointer transition-[background-color,scale] duration-150 active:scale-[0.96]',
              )}
            >
              Use
            </button>
          </div>
        </div>
      )}
    </MenuCard>
  );
}
