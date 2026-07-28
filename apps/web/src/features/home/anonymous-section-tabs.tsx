'use client';

/**
 * The section tab strip for the logged-out previews.
 *
 * Same shape and classes as ProjectSectionTabs — it differs only in where the
 * links point (`/?view=` instead of `/projects/[id]/`), because there is no
 * project yet. Kept beside it rather than merged so the signed-in strip stays
 * a plain, route-driven component.
 */

import Link from 'next/link';

import { PROJECT_NAV_ITEMS, type ProjectNavKey } from '@/lib/project-nav';
import { cn } from '@/lib/utils';

export function AnonymousSectionTabs({ active }: { active: ProjectNavKey }) {
  return (
    <nav
      aria-label="Project sections"
      className="border-border flex shrink-0 items-center gap-1 border-b px-6"
    >
      {PROJECT_NAV_ITEMS.map((item) => {
        const isActive = item.key === active;
        return (
          <Link
            key={item.key}
            href={`/?view=${item.key}`}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative -mb-px border-b-2 px-2 py-2.5 text-sm transition-colors',
              isActive
                ? 'border-foreground text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default AnonymousSectionTabs;
