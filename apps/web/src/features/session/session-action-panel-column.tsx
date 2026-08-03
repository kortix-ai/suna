'use client';

/**
 * The action panel column — the Outputs/Context/Preview cards, and the chevron
 * that toggles them, as a real column in the session's layout.
 *
 * IN FLOW, never an overlay. It sits beside the chat as a sibling, so opening
 * it takes width away from the transcript and the chat re-centers itself in
 * what is left. An absolutely positioned version floated over the conversation
 * and covered it; this one moves it.
 *
 * That is also why there is no `pointer-events-none` dance here any more. The
 * panel occupies space it owns, so it can never sit on top of text the user is
 * trying to select.
 *
 * Deliberately chrome-free. No wrapper card, radius, shadow, border, or
 * background: the three cards carry their own borders and ARE the containers.
 * Anything drawn around them would be a box around boxes.
 *
 * It toggles ONLY itself. Opening it never opens the right-hand detail panel;
 * that surface is content-driven and opens when something gives it a detail to
 * show. See the store's `isActionPanelOpen` doc comment.
 *
 * The reverse is a RENDER rule, not a state one: while a detail panel is up
 * (browser, terminal, files, file preview) this whole column hides, so the
 * session is the chat plus the one thing being looked at. No state is written
 * for that — closing the detail brings the column back as it was.
 *
 * The chevron is the only way to open it — there is no keyboard shortcut.
 */

import Hint from '@/components/ui/hint';
import { ActionPanel } from '@/features/session/action-panel';
import { useOptionalSessionPanel } from '@/features/session/action-panel/session-panel-provider';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import {
  useIsActionPanelOpen,
  useIsSidePanelOpen,
  useReadyChip,
  useToggleActionPanel,
} from '@/stores/kortix-computer-store';
import { CaretDoubleLeftIcon, CaretDoubleRightIcon } from '@phosphor-icons/react';
import { motion, useReducedMotion } from 'motion/react';

/** The panel's open width. The inner content is pinned to it so the cards keep
 *  their true width while the container widens — they slide into view rather
 *  than reflowing from squashed to correct on every frame. */
const PANEL_WIDTH = 380;

/**
 * Motion. This is the one place in this work that animates a LAYOUT property,
 * and it is deliberate: pushing the chat aside IS a layout change, so there is
 * no transform that can express it. The cost is bounded — one 200ms one-shot
 * on an explicit toggle, on a single element.
 *
 * Ease-out, because the panel is entering and leaving the screen and the
 * acceleration belongs up front where the eye already is. 200ms in, 160ms out:
 * exits run ~80% of the entrance, since leaving is a decision already made.
 */
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const ENTER = { duration: 0.2, ease: EASE_OUT } as const;
const EXIT = { duration: 0.16, ease: EASE_OUT } as const;

export function SessionActionPanelColumn() {
  const panel = useOptionalSessionPanel();
  const isMobile = useIsMobile();
  const isOpen = useIsActionPanelOpen();
  const toggle = useToggleActionPanel();
  const readyChip = useReadyChip();
  const reduce = useReducedMotion();
  // The right-hand detail panel is showing a browser, a terminal, a file
  // explorer or a file preview. Post-refactor that panel is content-driven, so
  // this flag is true exactly when one of those is on screen.
  const detailPanelOpen = useIsSidePanelOpen();

  // No provider means no panel to render: `SessionChat` also renders read-only
  // inside `sub-session-modal.tsx`, outside `SessionLayout`. Mobile has no
  // column either — at 375px a side column is the whole screen, so the cards
  // stay in the bottom drawer they have always used.
  if (!panel || isMobile) return null;

  const sessionId = panel.sessionId;
  const showReadyDot = readyChip?.sessionId === sessionId && !isOpen;
  const label = isOpen ? 'Collapse pane' : 'Expand pane';

  return (
    <div
      className={cn(
        'group/panel flex min-h-0 shrink-0 items-start gap-2 py-3',
        // A detail panel is showing on the right. The action panel steps aside
        // ENTIRELY — the control and the cards — so the session is the chat
        // plus the one thing being looked at, not a transcript squeezed
        // between two panels.
        //
        // Hiding only the chevron would be worse than leaving it: with the
        // cards expanded there would be no way left to collapse them.
        //
        // `hidden` rather than an unmount, so the cards keep their own
        // expanded/collapsed state and it costs no layout. And render-only on
        // purpose: `isActionPanelOpen` is never written here, so closing the
        // detail brings the column back exactly as the user left it. The two
        // states stay independent — only what is PAINTED depends on both.
        detailPanelOpen && 'hidden',
      )}
      data-testid="session-action-panel"
    >
      <Hint side="left" sideOffset={4} delayDuration={300} label={label}>
        <button
          type="button"
          aria-label={label}
          aria-expanded={isOpen}
          onClick={toggle}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            'text-foreground/80 hover:text-foreground hover:bg-accent',
            'transition-[color,background-color,transform,opacity] duration-150 ease-out active:scale-[0.96]',
            // Expanded, the collapse control steps out of the way: the cards
            // are the content, and a permanently visible chevron beside them is
            // chrome the user has already read. Hovering anywhere in the column
            // brings it back, as does tabbing to it.
            //
            // `pointer-events-none` rides WITH the fade, deliberately. Opacity
            // zero still occupies space AND still receives pointer events, so a
            // faded-out button stays clickable — an invisible hit target pinned
            // against the panel's edge. (This is the opacity/visibility
            // distinction: `visibility: hidden` would drop interaction for us,
            // but it is not animatable, and the fade is the point.) Both are
            // restored together on reveal. Focus is unaffected by
            // `pointer-events`, so the keyboard path still reaches it.
            isOpen
              ? 'pointer-events-none opacity-0 group-hover/panel:pointer-events-auto group-hover/panel:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
              : 'mr-1',
          )}
        >
          <span className="relative inline-flex">
            {isOpen ? (
              <CaretDoubleRightIcon className="size-4" />
            ) : (
              <CaretDoubleLeftIcon className="size-4" />
            )}
          </span>
        </button>
      </Hint>

      {/* Never unmounted — width alone opens and closes it, and the column's
          own `hidden` (above) covers the detail-panel case, so the cards keep
          their expand/collapse state through both. `initial={false}` means
          a session that mounts with the panel already open shows it at full
          width immediately instead of playing an arrival nobody asked for.
          The transition ternary is safe here precisely BECAUSE this element
          never unmounts: there is no exiting node holding stale props. */}
      <motion.div
        initial={false}
        animate={{ width: isOpen ? PANEL_WIDTH : 0 }}
        transition={reduce ? { duration: 0 } : isOpen ? ENTER : EXIT}
        aria-hidden={!isOpen}
        inert={!isOpen || undefined}
        className="max-h-full min-h-0 overflow-hidden"
      >
        <div className="max-h-full overflow-y-auto pr-3" style={{ width: PANEL_WIDTH }}>
          <ActionPanel />
        </div>
      </motion.div>
    </div>
  );
}
