'use client';

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { SidebarToggle as PanelRight } from '@/features/icon/icons/sidebar-toggle';
import { CaretRightIcon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ToolSurfaceContext } from './surface';
import { BoundActivateContext, ToolDurationContext, ToolOpenContext, ToolOutcomeContext, ToolRunningContext } from './infrastructure-contexts';
import { PanelRowTitle, TOOL_ROW_CLASS, ToolHeaderRow, ToolOutcomeIcon } from './infrastructure-row-header';
import { isTriggerTitle } from './infrastructure-parts';
import { type BasicToolProps } from './types';
import { type ToolOutcome } from './tool-outcome';
import { type TriggerTitle } from '@/ui';

/**
 * Side-panel surface: one closed-by-default disclosure row per tool call.
 *
 * The panel is not a page for a single call. A Progress step or a Context group
 * hands the detail N calls at once, and the old layout answered that with N
 * sticky `px-4 pt-4 pb-3` headers and N padded bodies stacked down the pane —
 * the same title treatment repeated, every payload open, nothing skimmable.
 * A row inverts it: the detail opens as a list of one-line summaries, and the
 * reader expands the one they came for.
 *
 * The row is the `bg-popover rounded-md border` surface the design system uses
 * for every panel row, and its disclosure affordance is the same MARK the Easy
 * cards use — a `CaretRightIcon` that points down once the thing is open. Only
 * the mark is shared: `PanelCard` sits on `bg-pane` at a tighter radius and
 * animates its chevron through `motion` with a press scale, while this row is a
 * denser, plainer thing that rotates its chevron in CSS. Same vocabulary, not
 * the same component. No rail, no connector, no per-row header: the gap between
 * rows is the whole rhythm.
 *
 * Interaction is gated on having a body — a childless call has nothing to
 * disclose, so it gets no chevron, no `role="button"`, and no cursor change
 * rather than a control that does nothing. `locked` keeps the trigger (a locked
 * row must still be openable) and only drops the pointer affordance; refusing
 * the close is {@link BasicTool}'s `handleOpenChange`, shared with inline.
 */
function PanelToolRow({
  icon,
  trigger,
  children,
  running,
  badge,
  outcome,
  onSubtitleClick,
  locked,
  open,
  onOpenChange,
  className,
  action,
}: {
  icon?: React.ReactNode;
  trigger: TriggerTitle | React.ReactNode;
  children?: React.ReactNode;
  running: boolean;
  badge?: React.ReactNode;
  outcome: ToolOutcome;
  onSubtitleClick?: () => void;
  locked?: boolean;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  className?: string;
  action?: React.ReactNode;
}) {
  const hasBody = Boolean(children);
  // Same substitution the inline header makes, from the same context — a failed
  // call leads with the verdict on both surfaces or the two disagree about what
  // happened. See {@link ToolOutcomeIcon}.
  const leading = outcome === 'ok' ? icon : <ToolOutcomeIcon outcome={outcome} />;

  const row = (
    <div
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 px-3 py-2.5 text-left',
        hasBody && 'transition-colors',
        hasBody && !locked && 'hover:bg-muted-foreground/[0.04] cursor-pointer',
      )}
    >
      {leading && (
        <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center [&>svg]:size-4">
          {leading}
        </span>
      )}
      {isTriggerTitle(trigger) ? (
        <PanelRowTitle trigger={trigger} running={running} onSubtitleClick={onSubtitleClick} />
      ) : (
        // `truncate` here CLIPS rather than ellipsises — a node trigger's
        // content is flex children (a label + chip row), and
        // `text-overflow` only applies to inline text. Clipping is the intent:
        // the row is one line, and an over-long node has to stop at the badge
        // rather than push the chevron off the card.
        <div className="[&>span:first-child>svg]:text-muted-foreground text-foreground min-w-0 flex-1 truncate text-sm font-medium [&>span:first-child>svg]:size-4">
          {trigger}
        </div>
      )}
      {badge && (
        <span className="text-muted-foreground/60 shrink-0 font-mono text-xs whitespace-nowrap tabular-nums">
          {badge}
        </span>
      )}
      {/* After the badge, before the chevron: the badge counts what the row
          holds, the chevron opens it, and the action leaves for somewhere else
          — so the two that concern THIS row stay adjacent to it. */}
      {action && <span className="flex shrink-0 items-center">{action}</span>}
      {hasBody && (
        <CaretRightIcon
          aria-hidden
          // CSS, not `motion` — the rotation is a 150ms state change on one
          // property, and every row on the pane would otherwise carry a
          // motion component. `motion-reduce` snaps it instead.
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
      )}
    </div>
  );

  return (
    <Disclosure
      open={open}
      onOpenChange={onOpenChange}
      className="bg-popover border-border overflow-hidden rounded-md border"
    >
      {hasBody ? <DisclosureTrigger>{row}</DisclosureTrigger> : row}
      {/* Animated for the same reason the inline row is — see
          `CollapsibleToolRow`. The border and inset ride the inner div rather
          than the animated element: they are the body's own chrome, and a
          border on a `height: 0` box draws a hairline across a closed row. */}
      {hasBody && (
        <DisclosureContent>
          <div className={cn('border-border border-t px-3 py-3 text-sm', className)}>
            {children}
          </div>
        </DisclosureContent>
      )}
    </Disclosure>
  );
}

// Inline row that acts as a plain button (fires `onClick`, no disclosure).
function ClickableToolRow({
  header,
  locked,
  onClick,
}: {
  header: React.ReactNode;
  locked?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      data-component="tool-trigger"
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(TOOL_ROW_CLASS, !locked && 'cursor-pointer')}
    >
      {header}
    </div>
  );
}

// Inline row that opens the tool in the side panel on click.
function ActivatableToolRow({
  header,
  activate,
}: {
  header: React.ReactNode;
  activate: () => void;
}) {
  return (
    <div
      data-component="tool-trigger"
      role="button"
      tabIndex={0}
      onClick={() => activate()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      className={cn(TOOL_ROW_CLASS, 'cursor-pointer')}
    >
      {header}
      <PanelRight
        className="text-muted-foreground/30 size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-80"
        mirrored
      />
    </div>
  );
}

/**
 * Inline row that expands/collapses its children in place (the default layout).
 *
 * A row with no children is NOT a disclosure. It used to be one anyway: the
 * trigger was rendered unconditionally, so a childless row carried
 * `role="button"`, `aria-expanded="false"` and `tabIndex={0}` and answered a
 * click by toggling state that rendered nothing. The row said "press me to
 * open" to a screen reader, to the keyboard and to the pointer, three times
 * over, and then did nothing at all.
 *
 * It is most visible on a sub-agent row whose child session is not resident —
 * `useOpenCodeMessages` only holds a child's transcript while the parent is
 * streaming it, and `pruneDetachedSessions` evicts the older ones once a turn
 * dispatches more than a couple of agents. So the LAST agent in a group of
 * three opens and the first two are dead rows. But the defect belongs to every
 * childless tool, so the fix belongs here.
 *
 * `PanelToolRow` has always gated its trigger this way. The two surfaces are
 * one behaviour presented twice; this is the half that had drifted.
 */
function CollapsibleToolRow({
  header,
  children,
  locked,
  open,
  onOpenChange,
}: {
  header: React.ReactNode;
  children?: React.ReactNode;
  locked?: boolean;
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const hasBody = Boolean(children);

  const row = (
    <div
      data-component="tool-trigger"
      className={cn(TOOL_ROW_CLASS, hasBody && !locked && 'cursor-pointer')}
    >
      {header}
    </div>
  );

  return (
    <Disclosure open={open} onOpenChange={onOpenChange}>
      {hasBody ? <DisclosureTrigger>{row}</DisclosureTrigger> : row}

      {/* `DisclosureContent`, not a bare `{open && <div>}`. The raw conditional
          is why an expanding tool row POPPED while a thinking row in the same
          chain unfurled: `DisclosureContent` animates `height: 0 → auto` with
          opacity through `AnimatePresence` (see `ui/disclosure.tsx`), and
          `ThoughtChainStep` has always used it. Two presentations of one
          gesture, and this was the half that had drifted.

          The 4px seam is PADDING on a child of the animated element, never a
          margin on it. A margin sits outside the animated height, so a
          collapsed row would keep 8px of dead space; and a margin on the inner
          child would collapse straight back out through the `height: auto`
          element and escape the clip. Padding does neither. */}
      {hasBody && (
        <DisclosureContent className="text-xs">
          <div className="py-1">{children}</div>
        </DisclosureContent>
      )}
    </Disclosure>
  );
}

export function BasicTool({
  icon,
  trigger,
  children,
  defaultOpen = false,
  forceOpen,
  locked,
  onSubtitleClick,
  badge,
  onClick,
  className,
  durationMs: durationMsProp,
  triggerAction,
}: BasicToolProps) {
  const running = useContext(ToolRunningContext);
  const contextDuration = useContext(ToolDurationContext);
  const durationMs = durationMsProp ?? contextDuration;
  const outcome = useContext(ToolOutcomeContext);
  const surface = useContext(ToolSurfaceContext);
  const activate = useContext(BoundActivateContext);
  // `forceOpen` seeds the state as well as latching it. The effect below alone
  // could only open the row on the frame AFTER mount, so a call that arrives
  // already waiting on a permission or a question rendered closed once and then
  // snapped open — a flash of the wrong answer on the exact row whose prompt is
  // the point. The effect stays for the case it is actually for: `forceOpen`
  // flipping true on an already-mounted row.
  const [open, setOpen] = useState(defaultOpen || !!forceOpen);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  const handleOpenChange = useCallback(
    (value: boolean) => {
      if (locked && !value) return;
      setOpen(value);
    },
    [locked],
  );

  // Side-panel surface: a disclosure row, closed unless the caller seeded it
  // open. It runs on the SAME state the inline branch does — `defaultOpen`
  // seeds it, `forceOpen` latches it, `locked` refuses the close — because the
  // panel is a second presentation of one behavior, not a second behavior. The
  // branch used to ignore all three (plus `icon` and `outcome`) and render an
  // always-expanded page header instead.
  //
  // `onClick` stays inline-only: a panel row's click is its disclosure, and the
  // two tools that pass one (project-create / project-select) have no body, so
  // they render as the plain, non-interactive rows they already were here.
  if (surface === 'panel') {
    return (
      <ToolOpenContext.Provider value={open}>
        <PanelToolRow
          icon={icon}
          trigger={trigger}
          running={running}
          badge={badge}
          outcome={outcome}
          onSubtitleClick={onSubtitleClick}
          locked={locked}
          open={open}
          onOpenChange={handleOpenChange}
          className={className}
          action={triggerAction}
        >
          {children}
        </PanelToolRow>
      </ToolOpenContext.Provider>
    );
  }

  const header = (
    <ToolHeaderRow
      icon={icon}
      trigger={trigger}
      running={running}
      onSubtitleClick={onSubtitleClick}
      outcome={outcome}
      action={triggerAction}
    />
  );

  // Explicit click handler: behave as a plain button.
  if (onClick) {
    return <ClickableToolRow header={header} locked={locked} onClick={onClick} />;
  }

  // A bound "activate" context opens this tool in the side panel instead of
  // expanding inline. `defaultOpen` opts out the same way `forceOpen` does: a
  // tool that asks to start expanded is saying its payload belongs inline —
  // `show`'s whole purpose is presenting the carousel/content IN the chat, and
  // this row was collapsing it to a one-line "Show · 4 items" instead.
  if (activate && !locked && !forceOpen && !defaultOpen) {
    return <ActivatableToolRow header={header} activate={activate} />;
  }

  // Default: expand/collapse children inline.
  return (
    <ToolOpenContext.Provider value={open}>
      <CollapsibleToolRow
        header={header}
        locked={locked}
        open={open}
        onOpenChange={handleOpenChange}
      >
        {children}
      </CollapsibleToolRow>
    </ToolOpenContext.Provider>
  );
}
