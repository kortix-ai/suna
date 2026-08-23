'use client';

/**
 * The one list of changed files in the product.
 *
 * The session Changes tab, the proposed-change dialog and the diff modal used
 * to render three different lists: three status vocabularies, three toolbars,
 * three row layouts, and — in the dialog — a 270px file-tree sidebar with its
 * own scroll-spy, which is GitHub's "Files changed" tab rebuilt for a list that
 * is usually under fifteen rows.
 *
 * What a row has to carry is small: which file, what happened to it, how big
 * the change is, and a way to see it. That is a name, a tone dot, `+n −m`, and
 * a caret. Everything else the old rows carried — a status icon AND a status
 * word AND a card border AND a second copy of the counts in a summary bar —
 * was the same four facts said four times.
 */

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { DiffView } from '@/components/diff/diff-view';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { DiffStat, STATUS_DOT } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import {
  CaretRightIcon,
  ColumnsIcon,
  RowsIcon,
} from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';

import {
  changeKind,
  DIFF_LAYOUT_LABEL,
  diffViewportClass,
  fileCount,
  initiallyExpanded,
  shouldReseedExpansion,
  splitPath,
  totalChanges,
  type ChangeEntry,
  type DiffLayout,
} from './change-vocabulary';

/** Matches the disclosure motion used across the app's expandable rows. */
const ROW_TRANSITION = { duration: 0.18, ease: [0.23, 1, 0.32, 1] } as const;

// ---------------------------------------------------------------------------
// summary — the counts, said once
// ---------------------------------------------------------------------------

/**
 * `12 files · +142 −18`.
 *
 * The old session toolbar read `12 files changed | +3 M5 D4 | +142 −18` — four
 * numeric groups behind literal pipe characters, three of which the list below
 * already showed row by row. Two numbers is the whole summary anyone reads.
 */
export function ChangeSummary({
  entries,
  className,
}: {
  entries: ChangeEntry[];
  className?: string;
}) {
  const totals = useMemo(() => totalChanges(entries), [entries]);
  return (
    <span
      className={cn(
        'text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs tabular-nums',
        className,
      )}
    >
      <span className="shrink-0">{fileCount(totals.files)}</span>
      {(totals.additions > 0 || totals.deletions > 0) && (
        <>
          <span className="text-muted-foreground/40" aria-hidden>
            &bull;
          </span>
          <DiffStat additions={totals.additions} deletions={totals.deletions} />
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// layout toggle
// ---------------------------------------------------------------------------

/**
 * Stacked vs side by side. Hidden below `sm` on purpose: side-by-side needs
 * roughly 860px to be readable, and offering it in a 380px side panel is
 * offering a worse view.
 */
export function DiffLayoutToggle({
  layout,
  onChange,
  className,
}: {
  layout: DiffLayout;
  onChange: (layout: DiffLayout) => void;
  className?: string;
}) {
  return (
    <ButtonGroup className={cn('hidden sm:flex', className)}>
      {(['unified', 'split'] as const).map((value) => {
        const Icon = value === 'unified' ? RowsIcon : ColumnsIcon;
        const active = layout === value;
        return (
          <Hint key={value} label={DIFF_LAYOUT_LABEL[value]} side="bottom">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={DIFF_LAYOUT_LABEL[value]}
              aria-pressed={active}
              onClick={() => onChange(value)}
              className={cn(
                'active:scale-[0.96]',
                active
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground/70 hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
            </Button>
          </Hint>
        );
      })}
    </ButtonGroup>
  );
}

// ---------------------------------------------------------------------------
// one row
// ---------------------------------------------------------------------------

function ChangeRow({
  entry,
  layout,
  open,
  onOpenChange,
}: {
  entry: ChangeEntry;
  layout: DiffLayout;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const kind = changeKind(entry.kind);
  const { name, dir } = splitPath(entry.path);
  const from = entry.fromPath && entry.fromPath !== entry.path ? splitPath(entry.fromPath) : null;

  return (
    <li>
      {/* `group/row` rides on the element `Disclosure` stamps `data-state`
          onto, which is how every other collapsible in this codebase drives
          its caret. */}
      <Disclosure
        open={open}
        onOpenChange={onOpenChange}
        transition={ROW_TRANSITION}
        className="group/row"
      >
        <DisclosureTrigger>
          <div
            title={`${kind.label} — ${entry.path}`}
            className={cn(
              'group hover:bg-muted/40 flex min-h-10 w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors',
              'focus-visible:ring-kortix-base outline-none focus-visible:ring-[0.6px]',
            )}
          >
            <CaretRightIcon
              className="text-muted-foreground/40 size-3 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/row:rotate-90"
              aria-hidden
            />
            {/* Tone carries "what happened"; the word rides along for screen
                readers and the row title. A dot plus `+n −m` says it without
                spending a chip and an icon on the same fact. */}
            <span
              className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[kind.tone])}
              aria-hidden
            />
            <span className="sr-only">{kind.label}:</span>
            <span className="text-foreground min-w-0 shrink truncate text-sm">{name}</span>
            {dir && (
              <span className="text-muted-foreground/50 hidden min-w-0 shrink truncate text-xs sm:inline">
                {dir}
              </span>
            )}
            {from && (
              <span className="text-muted-foreground/50 hidden shrink-0 truncate text-xs md:inline">
                from {from.name}
              </span>
            )}
            <DiffStat
              additions={entry.additions}
              deletions={entry.deletions}
              className="ml-auto shrink-0 text-xs"
            />
          </div>
        </DisclosureTrigger>
        <DisclosureContent className="max-w-full overflow-hidden">
          <div className="border-border/60 border-t">
            {entry.patch ? (
              <div className="max-w-full overflow-x-auto">
                <DiffView
                  patch={entry.patch}
                  layout={layout}
                  hideFileHeader
                  className={cn('bg-background', diffViewportClass(layout))}
                />
              </div>
            ) : (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                This file has no preview.
              </p>
            )}
          </div>
        </DisclosureContent>
      </Disclosure>
    </li>
  );
}

// ---------------------------------------------------------------------------
// the list
// ---------------------------------------------------------------------------

/**
 * Expansion lives here so both the list and its toolbar's "Expand all" read one
 * set. `initiallyExpanded` opens the first row only — see its doc comment for
 * why neither "all open" nor "all closed" is right.
 *
 * `resetKey` identifies the subject being looked at, not its contents. Pass the
 * change-request id where one component serves many changes; leave it out where
 * the surface shows one thing for its whole life (the live session diff), so a
 * file the agent writes mid-run never collapses the row you are reading.
 */
export function useChangeExpansion(entries: ChangeEntry[], resetKey?: string) {
  const key = resetKey ?? '';
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Adjusting state during render, the React-documented alternative to an
  // effect: this re-renders before paint instead of after it, so the first row
  // is never briefly drawn collapsed.
  if (shouldReseedExpansion(seededFor, key, entries.length)) {
    setSeededFor(key);
    setExpanded(initiallyExpanded(entries));
  }

  const setRow = useCallback((path: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const allExpanded = entries.length > 0 && entries.every((e) => expanded.has(e.path));

  const toggleAll = useCallback(() => {
    setExpanded((prev) => {
      const everyOpen = entries.length > 0 && entries.every((e) => prev.has(e.path));
      return everyOpen ? new Set<string>() : new Set(entries.map((e) => e.path));
    });
  }, [entries]);

  return { expanded, setRow, allExpanded, toggleAll };
}

export function ExpandAllButton({
  allExpanded,
  onToggle,
  className,
}: {
  allExpanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onToggle}
      className={cn('text-muted-foreground hover:text-foreground active:scale-[0.96]', className)}
    >
      {allExpanded ? 'Collapse all' : 'Expand all'}
    </Button>
  );
}

export function ChangeList({
  entries,
  layout,
  expanded,
  onRowOpenChange,
  className,
}: {
  entries: ChangeEntry[];
  layout: DiffLayout;
  expanded: Set<string>;
  onRowOpenChange: (path: string, open: boolean) => void;
  className?: string;
}) {
  return (
    <ul
      className={cn(
        'bg-popover divide-border/60 divide-y overflow-hidden rounded-md border',
        className,
      )}
    >
      {entries.map((entry) => (
        <ChangeRow
          key={entry.path}
          entry={entry}
          layout={layout}
          open={expanded.has(entry.path)}
          onOpenChange={(open) => onRowOpenChange(entry.path, open)}
        />
      ))}
    </ul>
  );
}
