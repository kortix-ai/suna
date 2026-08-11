'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { SidebarSimpleIcon as PanelLeft } from '@phosphor-icons/react';
import Link from 'next/link';
import type React from 'react';

type Props = {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  docs?: string;
  className?: string;
  /**
   * Fixed-shell mode. The header becomes a non-scrolling top bar and `children`
   * fill the remaining height to own their own scroll — used by the master-detail
   * split, where the section header, list, and aside stay put and only the
   * content pane scrolls. Default is the single scrolling column.
   */
  fill?: boolean;
  /**
   * Exposes the scrollable ancestor div (the one carrying `overflow-y-auto`)
   * to callers that need to virtualize a list against it — e.g.
   * `MarketplaceBrowser`'s `@tanstack/react-virtual` grid — without coupling
   * to this component's internal class names.
   */
  scrollContainerRef?: React.Ref<HTMLDivElement>;
  /**
   * Floating open/collapse control at the top-left of this section. Opt-in —
   * the workspace shell no longer mounts a mobile sheet opener, so pages that
   * sit under this wrapper without their own header toggle need this. Default
   * off so existing callers keep their layout.
   */
  showSidebarToggleButton?: boolean;
};

/**
 * Absolute top-left opener. Visibility matches workspace-home / session header:
 * always on mobile (sheet has no docked affordance); desktop only while the
 * panel is undocked — the sidebar header already carries collapse when expanded.
 */
function SectionSidebarToggle() {
  const sidebar = useOptionalSidebar();
  if (!sidebar) return null;
  if (!sidebar.isMobile && sidebar.state === 'expanded') return null;

  const label =
    sidebar.state === 'expanded'
      ? 'Collapse sidebar'
      : sidebar.peek
        ? 'Pin sidebar'
        : 'Open sidebar';

  return (
    <Hint label={label} side="bottom">
      <Button
        type="button"
        aria-label={label}
        variant="ghost"
        size="icon"
        onClick={sidebar.toggleSidebar}
        onPointerEnter={sidebar.state === 'collapsed' ? sidebar.peekEnter : undefined}
        onPointerLeave={sidebar.state === 'collapsed' ? sidebar.peekLeave : undefined}
        className="hover:bg-sidebar-accent hover:text-sidebar-foreground absolute top-2 left-2 z-20 shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
      >
        <PanelLeft className="cn-rtl-flip size-4" />
      </Button>
    </Hint>
  );
}

function useShowSectionSidebarToggle(enabled: boolean): boolean {
  const sidebar = useOptionalSidebar();
  if (!enabled || !sidebar) return false;
  return sidebar.isMobile || sidebar.state !== 'expanded';
}

const CustomizeSectionWrapper = ({
  title,
  description,
  children,
  action,
  docs,
  className,
  fill,
  scrollContainerRef,
  showSidebarToggleButton = false,
}: Props) => {
  const showToggle = useShowSectionSidebarToggle(showSidebarToggleButton);

  const heading = (
    <div className="space-y-1">
      <h2 className="text-foreground text-xl font-medium">{title}</h2>
      {description || docs ? (
        <span className="flex items-center gap-1">
          {description ? (
            <p className="text-muted-foreground text-sm text-balance">{description}</p>
          ) : null}
          {docs && (
            <Button variant="transparent" className="m-0 p-0" asChild>
              <Link href={docs} target="_blank" rel="noopener noreferrer">
                Learn more.
              </Link>
            </Button>
          )}
        </span>
      ) : null}
    </div>
  );

  if (fill) {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        {showSidebarToggleButton ? <SectionSidebarToggle /> : null}
        <header
          className={cn(
            'border-border/60 flex shrink-0 flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:items-center sm:justify-between',
            // Clear the absolute toggle so the title does not sit under it.
            showToggle && 'pl-12',
          )}
        >
          {heading}
          {action ? <div className="mt-2 shrink-0 sm:mt-0">{action}</div> : null}
        </header>
        <div
          ref={scrollContainerRef}
          className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden"
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {showSidebarToggleButton ? <SectionSidebarToggle /> : null}
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            'mx-auto w-full max-w-3xl space-y-5 px-4 py-10 pb-20 lg:py-20',
            // showToggle && 'pl-12',
            className,
          )}
        >
          <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            {heading}
            {action ? <div className="mt-2 shrink-0 sm:mt-0">{action}</div> : null}
          </header>

          {children}
        </div>
      </div>
    </div>
  );
};

export default CustomizeSectionWrapper;
