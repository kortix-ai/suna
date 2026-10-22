'use client';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { SidebarGlyph as PanelLeft } from '../../icons/sidebar-toggle';
import { useIsMobile } from '../../internal/hooks';
import { cn } from '../../lib/utils';
import { useKortixComputerStore } from '../../internal/stores/kortix-computer-store';
import { XIcon as X } from '@phosphor-icons/react';
import { useSyncExternalStore } from 'react';

/** Closes the detail. Exported so a body with its own toolbar can host it. */
export function CloseButton({
  onClose,
  variant = 'secondary',
}: {
  onClose: () => void;
  /** `secondary` inside a toolbar `ButtonGroup` (every call site but a lone
   *  drawer close, which stays `ghost`). */
  variant?: 'secondary' | 'ghost';
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Button
      variant={variant}
      size="icon"
      onClick={onClose}
      aria-label={tI18nComplete.raw('text7d9eb7acb13e')}
      className="size-7 shrink-0 active:scale-[0.96]"
    >
      {/* `size-3.5`, not `size-4`: an X is a full-bleed glyph — it fills its
          own box corner to corner, where an arrow or a caret leaves margin. At
          a matched nominal size it reads a step larger than every icon beside
          it, which is exactly how it looked in this toolbar. */}
      <X className="size-3.5" />
    </Button>
  );
}

// zustand v5's own hook feeds React's `useSyncExternalStore` a
// `getServerSnapshot` pinned to `getInitialState()` (see `app-preview.tsx`'s
// `getSandboxAliveSnapshot` for the full explanation) — under
// `renderToStaticMarkup` that would make `DetailSidebarToggle`'s fullscreen
// gate permanently read the store's pristine `isExpanded: false`, no matter
// what a test's `setState` call says. Reading through `getState()` for both
// snapshots sidesteps that — same live value, same reactivity via
// `subscribe`, no behavior change in the browser or real SSR.
function useFullscreenSnapshot(): boolean {
  return useSyncExternalStore(
    useKortixComputerStore.subscribe,
    () => useKortixComputerStore.getState().isExpanded,
    () => useKortixComputerStore.getState().isExpanded,
  );
}

/**
 * The shell's floating sidebar toggle (project-shell.tsx / session-layout.tsx)
 * gets painted over while the detail view is fullscreen — the panel subtree
 * elevates to z-[35] to sit above it (see session-layout.tsx). So fullscreen
 * needs its OWN reopen control, living inside the detail instead — this is
 * it. Self-gating: it renders null whenever any of its conditions don't
 * hold, so every call site can mount it unconditionally.
 *
 * Shown whenever the detail is fullscreen, regardless of the sidebar's own
 * state: collapsed → opens it (with the same hover-peek the floating toggle
 * offers), open/docked → collapses it. One button, one place, always the
 * opposite of whatever the sidebar currently is.
 *
 * `useOptionalSidebar` (not `useSidebar`) on purpose — the Easy panel also
 * mounts on /debug/tools, which has no `SidebarProvider`, and `useSidebar`
 * throws outside one.
 */
export function DetailSidebarToggle({ className }: { className?: string }) {
  const panelFullscreen = useFullscreenSnapshot();
  const isMobile = useIsMobile();
  const sidebar = useOptionalSidebar();

  if (!panelFullscreen || isMobile || !sidebar) return null;

  const { state, toggleSidebar, peek, peekEnter, peekLeave } = sidebar;
  // Owner direction (supersedes the show-in-every-state round): the docked
  // sidebar carries its own collapse control in its header, so a second one
  // inside the detail would be a duplicate — the in-detail toggle exists only
  // to REOPEN a collapsed sidebar the fullscreen detail is painting over.
  if (state === 'expanded') return null;

  const label = peek ? 'Pin sidebar' : 'Open sidebar';

  return (
    <Hint label={label} side="bottom">
      <Button
        type="button"
        aria-label={label}
        onClick={toggleSidebar}
        onPointerEnter={peekEnter}
        onPointerLeave={peekLeave}
        variant="ghost"
        size="icon"
        className={cn(
          'text-muted-foreground hover:text-foreground shrink-0 active:scale-[0.96]',
          className,
        )}
      >
        <PanelLeft className="cn-rtl-flip size-4" />
      </Button>
    </Hint>
  );
}
