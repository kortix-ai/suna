'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
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
   * the project shell no longer mounts a mobile sheet opener, so pages that
   * sit under this wrapper without their own header toggle need this. Default
   * off so existing callers keep their layout.
   */
  showSidebarToggleButton?: boolean;
};

/**
 * Absolute top-left opener. Visibility matches project-home / session header:
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

  // `docs` has no slot on `SettingsSectionHeader` (title/description/action/className
  // only — fixed across every consumer), so the "Learn more." link rides in the
  // same `action` slot as the real action, ahead of it.
  const headerAction =
    docs || action ? (
      <>
        {docs ? (
          <Button variant="transparent" className="m-0 p-0" asChild>
            <Link href={docs} target="_blank" rel="noopener noreferrer">
              Learn more.
            </Link>
          </Button>
        ) : null}
        {action}
      </>
    ) : undefined;

  const heading = (
    <SettingsSectionHeader title={title} description={description} action={headerAction} />
  );

  if (fill) {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        {showSidebarToggleButton ? <SectionSidebarToggle /> : null}
        <header
          className={cn(
            'border-border/60 shrink-0 border-b px-4 py-2',
            // Clear the absolute toggle so the title does not sit under it.
            showToggle && 'pl-12',
          )}
        >
          {heading}
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
        {/* `max-w-2xl` is the settings panel's content column — the same
            container every tab in `features/workspace/settings/tabs/` uses, and
            the width the design system prescribes ("Container: mx-auto w-full
            max-w-2xl"). This wrapper carried `max-w-3xl` until 2026-08-12, so
            Secrets / Channels / Schedules / Webhooks / Voice / Upgrades sat
            96px wider than General and the column jumped on every tab switch —
            even though `capability-page-shell.tsx` and `slack-connect-cover.tsx`
            already documented this wrapper as being `max-w-2xl`. A surface that
            genuinely needs more room overrides via `className` (twMerge keeps
            the caller's `max-w-*`), the way `apps-view.tsx` takes `max-w-5xl`
            for its card grid. `tab-content-width.test.ts` holds the rule. */}
        <div
          className={cn(
            'mx-auto w-full max-w-2xl space-y-8 ',
            // showToggle && 'pl-12',
            className,
          )}
        >
          <header>{heading}</header>

          {children}
        </div>
      </div>
    </div>
  );
};

export default CustomizeSectionWrapper;
