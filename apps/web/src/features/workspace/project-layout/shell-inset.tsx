'use client';

/**
 * The content side of the product shell.
 *
 * ONE component, used by the signed-in project shell and the signed-out
 * homepage. It exists because those two grew separate wrappers: the signed-in
 * one carried `bg-background`, the `border-l` seam against the sidebar, and the
 * edge-peek strip; the signed-out one hand-rolled a bare div with none of it.
 * The result was a visibly different panel edge and background — the two read
 * as different apps, which is the one thing the logged-out page must not do.
 *
 * Anything that differs by auth state belongs in `children`, not here.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { SidebarEdgePeek, useSidebar } from '@/components/ui/sidebar';
import { SidebarPeekToggle } from '@/features/workspace/project-sidebar/sidebar-peek-toggle';
import { desktopShellPlatform } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { PanelLeft } from 'lucide-react';

export function ShellInset({ children }: { children: React.ReactNode }) {
  const { state, toggleSidebar, peek, peekEnter, peekLeave } = useSidebar();
  const isExpanded = state === 'expanded';
  // The sidebar hides fully when collapsed (offcanvas everywhere, no icon
  // rail), so a hidden sidebar means no seam border. The reopen control lives
  // in the title-bar band next to the OS window controls on the desktop shell,
  // and in each view's top-left cluster on the web.
  const [desktopShell] = useState(() => desktopShellPlatform());

  return (
    <div
      className={cn(
        'bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden',
        isExpanded && 'border-border border-l',
      )}
    >
      {/* Collapsed: an invisible strip on the viewport's left edge summons the
          sidebar as a hover flyout; it self-hides while docked open. */}
      <SidebarEdgePeek />

      {/* The one reopener, for every page. Self-hides while the panel is open,
          because the panel's own header carries the collapse control then.
          Scattering this across each page's toolbar is what kept producing two
          buttons a few pixels apart.

          Not on the desktop shell: there it would land on the traffic lights,
          so that build uses the offset button below instead. */}
      {!desktopShell && <SidebarPeekToggle className="absolute top-2 left-2 z-30" />}

      {desktopShell && !isExpanded && (
        <Hint label={peek ? 'Pin sidebar' : 'Open sidebar'} side="bottom">
          <Button
            type="button"
            aria-label={peek ? 'Pin sidebar' : 'Open sidebar'}
            onClick={toggleSidebar}
            onPointerEnter={peekEnter}
            onPointerLeave={peekLeave}
            variant="ghost"
            className={cn(
              // top-[12px] + 28px box centers the button on the traffic
              // lights' midline (y=26 — the app draws its own lights there;
              // see DesktopChrome → MacTrafficLights). px values on purpose:
              // the lights are positioned in window px, while rem sizes drift
              // with the root font size.
              'text-muted-foreground hover:text-foreground fixed top-[12px] z-50 flex h-[28px] w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out [-webkit-app-region:no-drag] [app-region:no-drag] active:scale-[0.96]',
              // macOS: sit just past the traffic lights (they end at x≈62),
              // mirroring their own 10px inset. Win/Linux: controls live
              // top-right, so hug the left edge instead.
              desktopShell === 'macos' ? 'left-[4.5rem]' : 'left-2',
            )}
          >
            <PanelLeft className="cn-rtl-flip size-4" />
          </Button>
        </Hint>
      )}
      {children}
    </div>
  );
}

export default ShellInset;
