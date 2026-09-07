'use client';

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

export interface TemplateCrumb {
  label: string;
  /** A route to link to. The last crumb is always the current page. */
  href?: string;
}

/**
 * The layout BOTH public template surfaces share — the `/templates` catalog and
 * one template's `/templates/<slug>` page.
 *
 * A pinned left rail carries identity (breadcrumb, title, description, the
 * action) and the wide right column carries the content. It is deliberately the
 * shape the old marketplace used for a project, because the two pages answer
 * the same question in the same order: *what is this, and what does it bring?*
 *
 * The rail is `sticky` rather than fixed, so the action and the breadcrumb stay
 * reachable while a long contents column scrolls, and it collapses to a normal
 * stacked block under `lg` where a 3-column rail would be a 90px gutter.
 *
 * `pt-28 lg:pt-32` clears the fixed `Navbar` the `(seo)` layout mounts — the
 * page is not inside a scroll container of its own, so nothing else offsets it.
 */
export function TemplateShell({
  crumbs,
  sidebar,
  children,
}: {
  crumbs: TemplateCrumb[];
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    // `px-6` at every width: with `max-w-6xl` the container already centres on a
    // wide screen, and dropping the padding at `lg` put the grid flush against
    // the viewport edge for every window between 1024px and 1152px.
    <div className="mx-auto max-w-6xl px-6 pt-28 pb-24 lg:pt-32">
      <div className="grid grid-cols-12 gap-6 lg:gap-8">
        {/* The breadcrumb sits INSIDE the sticky rail, not in a full-width row
            above the grid, so it stays pinned with the rail as the contents
            column scrolls. */}
        <div className="col-span-12 lg:col-span-3">
          <aside className="min-w-0 space-y-6 lg:sticky lg:top-32 lg:self-start">
            <Crumbs crumbs={crumbs} />
            {sidebar}
          </aside>
        </div>

        {/* `col-span-12` is load-bearing, not decoration. A grid child with no
            span occupies ONE of the twelve tracks, so without it this column was
            7px wide at 375px and 13px at 768px — the rail took the full row and
            the content was squeezed into a single track, wrapping prose one
            character per line. It only looked survivable on a phone because the
            cards spilled out of their track instead of being clipped. */}
        <div className="col-span-12 min-w-0 lg:col-span-9">{children}</div>
      </div>
    </div>
  );
}

function Crumbs({ crumbs }: { crumbs: TemplateCrumb[] }) {
  if (crumbs.length === 0) return null;
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.label}:${crumb.href ?? ''}`}>
              <BreadcrumbItem className="min-w-0">
                {isLast || !crumb.href ? (
                  <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href} className="truncate">
                      {crumb.label}
                    </Link>
                  </BreadcrumbLink>
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
 * A section heading in the contents column — the label plus how many things are
 * under it.
 *
 * The count is part of the heading rather than a badge beside it: it is the
 * answer to "how much does this bring", which is the question the whole column
 * exists to answer, and a badge would give it more weight than the label.
 */
export function TemplateSectionLabel({
  count,
  children,
}: {
  count?: number;
  children: ReactNode;
}) {
  return (
    <div className="text-muted-foreground mb-3 flex items-center gap-2 text-sm">
      <span>{children}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground/50 tabular-nums">{count}</span>
      ) : null}
    </div>
  );
}
