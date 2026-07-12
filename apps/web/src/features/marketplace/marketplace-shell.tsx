import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';

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

/**
 * The one layout every marketplace surface shares — the public landing/source
 * page, the item detail page, AND the in-project Customize overlay. A
 * breadcrumb trail pinned in a sticky left rail, plus a wide main column.
 *
 * `embedded` drops the marketing top/bottom padding + centering so the exact
 * same shell can render inside the Customize panel (which supplies its own
 * chrome), instead of as a full marketing page.
 */
export function MarketplaceShell({
  crumbs,
  sidebar,
  children,
  embedded = false,
}: {
  crumbs: MarketplaceCrumb[];
  sidebar: ReactNode;
  children: ReactNode;
  embedded?: boolean;
}) {
  return (
    <div className={cn(embedded ? 'w-full' : 'mx-auto max-w-6xl px-6 pt-28 pb-24 lg:px-0 lg:pt-32')}>
      <div className="grid grid-cols-12 gap-6 lg:gap-8">
        {/* The breadcrumb lives INSIDE the sticky rail (not a full-width row
            above the grid) so it stays pinned with the sidebar as the main
            column scrolls. */}
        <div className="col-span-12 lg:col-span-3">
          <aside
            className={cn(
              'min-w-0 space-y-6',
              !embedded && 'lg:sticky lg:top-32 lg:self-start',
            )}
          >
            <Breadcrumb>
              <BreadcrumbList>
                {crumbs.map((crumb, i) => {
                  const isLast = i === crumbs.length - 1;
                  return (
                    <Fragment key={`${crumb.label}-${i}`}>
                      <BreadcrumbItem className="min-w-0">
                        {isLast ? (
                          <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                        ) : crumb.onClick ? (
                          <BreadcrumbLink asChild>
                            <button
                              type="button"
                              onClick={crumb.onClick}
                              className="truncate cursor-pointer"
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
            {sidebar}
          </aside>
        </div>

        <div className="min-w-0 lg:col-span-9">{children}</div>
      </div>
    </div>
  );
}
