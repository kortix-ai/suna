'use client';

import { SidebarSimpleIcon as PanelLeft } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import {
  sidebarOpenerLabel,
  useShowPageSidebarOpener,
} from '@/features/workspace/project-layout/sidebar-opener';
import { cn } from '@/lib/utils';

/**
 * THE sidebar opener. One control, one file, every surface.
 *
 * The project sidebar is `collapsible="offcanvas"` — collapsed means gone, not
 * an icon rail — so every view that can be looked at with it hidden needs a way
 * back. `sidebar-opener.ts` already unified the RULE ("should this view draw
 * one?"); the CONTROL stayed copy-pasted, and six files ended up carrying the
 * same eighteen lines of `Hint` + ghost icon `Button` + peek wiring:
 *
 *   session-site-header.tsx · project-home.tsx · project-sessions-view.tsx
 *   capability-tabs.tsx · drive-header.tsx · apps-view.tsx
 *
 * They had already drifted — four wrapped the button in `Hint`, two did not —
 * and, worse, a surface with no header simply had no opener at all: collapse
 * the sidebar, then open a session that is booting or broken, and the only way
 * back was a page reload. A route cannot render a control it has to reimplement
 * first. It can render this one.
 *
 * Self-gating: it reads {@link useShowPageSidebarOpener} itself and returns
 * `null` when this view must not draw an opener (no sidebar context at all, the
 * Electron shell — which draws the canonical one in the OS title-bar band — or
 * a panel already docked open on desktop). Callers place it unconditionally;
 * they never re-derive the rule.
 *
 * NOT for the two surfaces with a genuinely different rule:
 * `project-shell.tsx`'s desktop-shell opener (renders only where this one is
 * suppressed) and `detail-view.tsx`'s `DetailSidebarToggle` (fullscreen Easy
 * panel, which also mounts with no `SidebarProvider` at all).
 */
export function SidebarToggle({
  className,
  placement = 'inline',
  side = 'bottom',
}: {
  className?: string;
  /**
   * `'inline'` — in flow with the row that hosts it. The default, and the right
   * answer whenever there is a header, tab bar, or toolbar to sit in.
   *
   * `'floating'` — `absolute top-2 left-2` over the surface, for the headerless
   * full-screen states (boot loader, terminal error cards) that have no row to
   * join. The nearest positioned ancestor must be `relative`.
   */
  placement?: 'inline' | 'floating';
  /** Tooltip side. `'bottom'` reads right under a top-of-screen control. */
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const sidebar = useOptionalSidebar();
  // Must be called before the early return — and it already covers `!sidebar`.
  const show = useShowPageSidebarOpener();
  if (!sidebar || !show) return null;

  const label = sidebarOpenerLabel(sidebar);
  // Peek is the collapsed-only hover flyout. Wiring it while the panel is
  // docked open would arm a flyout for a panel that is already on screen.
  const collapsed = sidebar.state === 'collapsed';

  return (
    <Hint label={label} side={side}>
      <Button
        type="button"
        aria-label={label}
        variant="ghost"
        size="icon"
        onClick={() => sidebar.toggleSidebar()}
        onPointerEnter={collapsed ? sidebar.peekEnter : undefined}
        onPointerLeave={collapsed ? sidebar.peekLeave : undefined}
        className={cn(
          'hover:bg-sidebar-accent hover:text-sidebar-foreground shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]',
          placement === 'floating' && 'absolute top-2 left-2 z-20',
          className,
        )}
      >
        {/* `cn-rtl-flip`: the glyph points at the panel's edge, which is the
            right edge in RTL. */}
        <PanelLeft className="cn-rtl-flip size-4" />
      </Button>
    </Hint>
  );
}
