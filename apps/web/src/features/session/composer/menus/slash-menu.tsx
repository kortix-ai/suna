'use client';

import { cn } from '@/lib/utils';
import {
  ArrowsClockwiseIcon,
  BrainIcon,
  MicrophoneIcon,
  PaperclipIcon,
  PlugsConnectedIcon,
  PuzzlePieceIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  TargetIcon,
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
      case 'start-voice':
        return <MicrophoneIcon className={className} />;
      case 'set-scope':
        return <TargetIcon className={className} />;
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
 * `rounded-xl` matches the composer card it stacks onto, so the two read as
 * one object split in two rather than a popover that happens to be nearby.
 * The list's `p-1.5` + the rows' `rounded-md` make that radius concentric
 * (6px inner + 6px padding = 12px outer); mismatched nesting here is the
 * single most visible way a card like this reads as "off".
 */
export function SlashMenu({
  sections,
  selectedIndex,
  onSelect,
}: {
  sections: SlashSection[];
  selectedIndex: number;
  onSelect: (row: SlashRow) => void;
}) {
  if (!sections.length) return null;

  const rows = sections.flatMap((section) =>
    section.rows.map((row) => ({ row, heading: section.heading })),
  );
  const active = rows.find(({ row }) => row.index === selectedIndex) ?? rows[0];

  return (
    // `rounded-2xl` (16px) tracks the composer card this stacks onto, so the
    // two read as one object split in two rather than a popover that happens
    // to be nearby. The list's `p-2` (8px) plus the rows' `rounded-lg` (8px)
    // makes that radius concentric: 8 + 8 = 16.
    <MenuCard className={cn('mb-2 flex max-h-96 h-88 overflow-hidden w-full rounded-lg shadow-none')}>
      <div
        role="listbox"
        aria-label="Commands and actions"
        aria-activedescendant={`slash-row-${selectedIndex}`}
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
                  {row.hint && (
                    <kbd className="bg-muted text-muted-foreground rounded-sm px-1.5 py-0.5 font-sans text-[0.6875rem]">
                      {row.hint}
                    </kbd>
                  )}
                </MenuRow>
              ))}
            </div>
          </div>
        ))}
      </div>

      {active && (
        <div className="border-border hidden w-[45%] max-w-[24rem] shrink-0 flex-col overflow-y-auto border-l p-4 sm:flex">
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
            <span className="text-muted-foreground text-xs">
              <kbd className="bg-muted rounded-sm px-1.5 py-0.5 font-sans">↵</kbd> to use
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
