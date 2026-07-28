'use client';

/**
 * The persistent section strip that sits above every project section screen,
 * mirroring the sidebar's Customize group — see
 * ux-references/perplexity/06-connectors-list.png, where
 * `Connectors | Skills | Workflows | Memory` stays put across all four pages.
 *
 * A link list, not a Tabs widget: each entry is a real route, so ⌘-click and
 * the back button behave.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { PROJECT_NAV_ITEMS, type ProjectNavKey } from '@/lib/project-nav';
import { cn } from '@/lib/utils';

export function ProjectSectionTabs({
  projectId,
  active,
  /** Hide items the viewer cannot open. Undefined means show everything. */
  visibleKeys,
}: {
  projectId: string;
  active?: ProjectNavKey;
  visibleKeys?: readonly ProjectNavKey[];
}) {
  const pathname = usePathname();
  const items = visibleKeys
    ? PROJECT_NAV_ITEMS.filter((item) => visibleKeys.includes(item.key))
    : PROJECT_NAV_ITEMS;

  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Project sections"
      className="border-border flex shrink-0 items-center gap-1 border-b px-6"
    >
      {items.map((item) => {
        const href = `/projects/${projectId}/${item.segment}`;
        const isActive = active ? active === item.key : pathname?.startsWith(href);
        return (
          <Link
            key={item.key}
            href={href}
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

export default ProjectSectionTabs;
