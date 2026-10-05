'use client';

import Link from 'next/link';
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { cn } from '@/lib/utils';

export interface MarketplaceCrumb {
  label: string;
  /** A route to link to (public pages). */
  href?: string;
  /** A click handler (in-panel back navigation) — takes precedence over href. */
  onClick?: () => void;
}

function Crumbs({ crumbs }: { crumbs: MarketplaceCrumb[] }) {
  if (crumbs.length === 0) return null;
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.label}:${crumb.href ?? ''}`}>
              <BreadcrumbItem className="min-w-0">
                {isLast ? (
                  <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                ) : crumb.onClick ? (
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      onClick={crumb.onClick}
                      className="cursor-pointer truncate"
                    >
                      {crumb.label}
                    </button>
                  </BreadcrumbLink>
                ) : crumb.href ? (
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href} className="truncate">
                      {crumb.label}
                    </Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {!isLast ? <BreadcrumbSeparator /> : null}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * Embedded (Customize panel) layout: the rail stays put on desktop and ONLY the
 * main column scrolls. A top fade appears once that column is scrolled — the
 * same cue the sidebar session list uses — so the fixed tab bar above reads as
 * elevated over the content sliding under it.
 */
function EmbeddedShell({
  crumbs,
  sidebar,
  children,
  scrollRef,
}: {
  crumbs: MarketplaceCrumb[];
  sidebar: ReactNode;
  children: ReactNode;
  scrollRef?: RefObject<HTMLElement | null>;
}) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);

  // Merge our scroll-tracking ref with the caller's virtualization ref so the
  // grid still measures against the same element that we watch for scroll.
  const setMainRef = useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node;
      if (scrollRef) scrollRef.current = node;
    },
    [scrollRef],
  );

  useEffect(() => {
    const el = localRef.current;
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 1);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row lg:gap-8">
      <aside className="space-y-6 lg:w-64 lg:shrink-0 lg:self-stretch lg:overflow-y-auto lg:pr-1">
        <Crumbs crumbs={crumbs} />
        {sidebar}
      </aside>
      <div className="relative min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            'from-background pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b to-transparent transition-opacity duration-(--duration-moderate)',
            scrolled ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden
        />
        <div ref={setMainRef} className="h-full overflow-y-auto lg:pr-1">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The one layout every marketplace surface shares — the public landing/source
 * page, the item detail page, AND the in-project Customize overlay. A
 * breadcrumb trail pinned in a left rail, plus a wide main column.
 *
 * - **Page** (default): window-scrolled, a 3/12 rail `sticky` to the viewport
 *   beside a 9/12 main column that runs to the container's right edge.
 * - **`embedded`** (Customize panel): the whole thing fills its parent's height
 *   (`h-full`); on desktop the rail stays put and ONLY the main column scrolls
 *   (`scrollRef` is attached there so a virtualized grid measures against it),
 *   with a top fade once scrolled.
 */
export function MarketplaceShell({
  crumbs,
  sidebar,
  children,
  embedded = false,
  sidebarLast = false,
  scrollRef,
}: {
  crumbs: MarketplaceCrumb[];
  sidebar: ReactNode;
  children: ReactNode;
  embedded?: boolean;
  /** Page only: below `lg`, render the rail after the main column. */
  sidebarLast?: boolean;
  /** Embedded only: attached to the scrolling main column (grid virtualizes
   *  against it). Typed broadly to match the grid's ref; it's a `div`. */
  scrollRef?: RefObject<HTMLElement | null>;
}) {
  if (embedded) {
    return (
      <EmbeddedShell crumbs={crumbs} sidebar={sidebar} scrollRef={scrollRef}>
        {children}
      </EmbeddedShell>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-6 pt-28 pb-24 lg:pt-32">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-5">
        {/* The rail is sticky on desktop; its breadcrumb lives inside it so it
            stays pinned with the sidebar as the main column scrolls. On a
            detail page (`sidebarLast`) the rail's metadata reads after the
            content on mobile, the way the content-first column expects. */}
        <aside
          className={cn(
            'min-w-0 space-y-6 lg:sticky lg:top-32 lg:col-span-3 lg:self-start',
            sidebarLast && 'order-last lg:order-none',
          )}
        >
          <Crumbs crumbs={crumbs} />
          {sidebar}
        </aside>

        <div className="min-w-0 lg:col-span-9">{children}</div>
      </div>
    </div>
  );
}
