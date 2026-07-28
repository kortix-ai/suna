'use client';

/**
 * Collapse / reopen the sidebar, with hover-peek while it is collapsed.
 *
 * The session header and the project home each grew their own copy of this
 * button, so every OTHER surface — Files, the sessions list, and the section
 * screens — had no way to collapse the sidebar and no peek affordance at all.
 * This is the shared one those surfaces use.
 *
 * Hovering while collapsed summons the flyout (the same gesture as the
 * viewport-edge strip); clicking pins or unpins it.
 */

import { PanelLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

export function SidebarPeekToggle({ className }: { className?: string }) {
  // Optional context on purpose. This now sits inside ProjectSectionPage, which
  // is also rendered on surfaces that have no sidebar at all (previews, tests).
  // A hard useSidebar there would throw rather than simply omit the control.
  const sidebar = useOptionalSidebar();
  if (!sidebar) return null;

  const { state, toggleSidebar, peek, peekEnter, peekLeave } = sidebar;
  const collapsed = state !== 'expanded';
  const label = collapsed ? (peek ? 'Pin sidebar' : 'Open sidebar') : 'Collapse sidebar';

  // Renders in BOTH states on purpose. Hiding it while the sidebar was open
  // left most pages with no way to collapse at all — the panel has no control
  // of its own, so this is it.

  return (
    <Hint label={label} side="bottom">
      <Button
        type="button"
        aria-label={label}
        variant="ghost"
        size="icon"
        onClick={toggleSidebar}
        onPointerEnter={collapsed ? peekEnter : undefined}
        onPointerLeave={collapsed ? peekLeave : undefined}
        className={cn(
          'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground -ml-1 shrink-0 cursor-pointer rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]',
          className,
        )}
      >
        <PanelLeft className="cn-rtl-flip size-4" />
      </Button>
    </Hint>
  );
}

export default SidebarPeekToggle;
