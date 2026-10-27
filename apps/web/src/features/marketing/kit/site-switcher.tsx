'use client';

import Link from '@/components/site-link';
import { cn } from '@kortix/ui';
import { usePathname } from 'next/navigation';

/** The site's two halves: the product and the done-for-you service. */
const SITES = [
  { id: 'os', label: 'AI OS', href: '/' },
  { id: 'services', label: 'Services', href: '/services' },
] as const;

/**
 * A segmented pair of links between the AI OS site and the /services sales
 * page. The current half is filled. Sits next to the logo in both headers.
 */
export function SiteSwitcher({ className }: { className?: string }) {
  const current = /\/services\/?$/.test(usePathname() ?? '') ? 'services' : 'os';
  return (
    <nav aria-label="Site" className={cn('bg-muted flex items-center rounded-md p-0.5', className)}>
      {SITES.map((site) => (
        <Link
          key={site.id}
          href={site.href}
          aria-current={site.id === current ? 'page' : undefined}
          className="text-muted-foreground hover:text-foreground aria-[current=page]:bg-background aria-[current=page]:text-foreground outline-ring duration-moderate flex h-7 items-center rounded-sm px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2"
        >
          {site.label}
        </Link>
      ))}
    </nav>
  );
}
